import express from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, type RegisterModule, type Doc } from '../../context.js';
import { getHub, idempotent, invalid, latestVersioned, notFound, str, wsOf } from './common.js';
import { cardsToStored, isUiCard, type UiCard } from './criteriaMap.js';
import { cancelActive, executeRun, inputSnapshot, newRunId, newTrace, TERMINAL_RUN_EVENTS, type ErunDoc } from './execute.js';

const effective = (v: any): string => v?.manual?.decision ?? v?.decision;

const register: RegisterModule = (router, ctx) => {
  const json = express.json({ limit: '256kb' });
  const hub = getHub(ctx);

  const limitsOf = () => ({
    maxItems: ctx.config.limits.maxItems, maxDetails: ctx.config.limits.maxDetails,
    runSeconds: ctx.config.limits.runSeconds, modelCalls: ctx.config.limits.modelCalls,
  });

  // body.criteria(UI 카드 배열) 또는 body.criteriaSetId(저장된 조건)를 받아 criteria 문서를 돌려준다.
  const resolveCriteria = async (ws: string, b: any, fallbackSetId?: string): Promise<Doc | undefined> => {
    if (Array.isArray(b.criteria)) {
      const cards = b.criteria.filter(isUiCard) as UiCard[];
      if (!cards.length) invalid('criteria에 카드가 하나 이상 필요해요');
      const setId = typeof b.criteriaSetId === 'string' && b.criteriaSetId ? b.criteriaSetId : `cs_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const prev = await ctx.store.list<any>(ws, 'criteriaSet', `criteria:${setId}:`);
      const version = prev.reduce((m, d) => Math.max(m, Number(d.version ?? 0)), 0) + 1;
      return ctx.store.upsert({
        id: `criteria:${setId}:v${version}`, type: 'criteriaSet', workspaceId: ws, criteriaSetId: setId, version,
        ...cardsToStored(cards), origin: 'manual',
      });
    }
    const setId = typeof b.criteriaSetId === 'string' && b.criteriaSetId ? b.criteriaSetId : fallbackSetId;
    if (!setId) invalid('criteria 또는 criteriaSetId 값이 필요해요');
    return latestVersioned<Doc>(ctx, ws, 'criteriaSet', `criteria:${setId}`, b.criteriaVersion);
  };

  const accepted = (runId: string, extra: Record<string, unknown> = {}) => ({ id: runId, runId, evaluationRunId: runId, eventsUrl: `/api/runs/${runId}/events`, ...extra });

  const loadRun = async (ws: string, id: string) => {
    const run = await ctx.store.get<ErunDoc>(ws, `erun:${id}`);
    if (!run) notFound();
    return run!;
  };

  const launch = (ws: string, runId: string, reuseCollection: boolean) => {
    void executeRun(ctx, { ws, runId, reuseCollection }).catch(() => undefined);
  };

  router.post('/api/runs', json, async (req, res) => {
    const ws = wsOf(req);
    const idem = await idempotent(ctx, req, 'run');
    if (idem.existing) { res.status(200).json(accepted(idem.existing)); return; }
    const b = req.body ?? {};
    const contractId = str(b.contractId, 'contractId');
    const resumeId = str(b.resumeId, 'resumeId');
    const contract = await latestVersioned<Doc>(ctx, ws, 'contract', `contract:${contractId}`, b.contractVersion);
    const resume = await ctx.store.get(ws, `resume:${resumeId}`);
    if (!contract || !resume) notFound();
    ctx.assertRunAllowed(ws);
    const criteria = await resolveCriteria(ws, b);
    if (!criteria) notFound();
    const criteriaSetId = String((criteria as any).criteriaSetId);
    const snapshot = inputSnapshot(criteria, resume);

    const runId = newRunId();
    const doc: ErunDoc = {
      id: `erun:${runId}`, type: 'evaluationRun', workspaceId: ws, evaluationRunId: runId,
      collectionRunId: `crun_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      contractId, contractVersion: Number((contract as any).version ?? 1),
      criteriaSetId, criteriaVersion: Number((criteria as any).version ?? 1), resumeId, ...snapshot,
      status: 'running', stage: 'collect', verdictCount: 0, itemCount: 0,
      traceId: newTrace(), createdAt: new Date().toISOString(), limits: limitsOf(), ttl: 604800,
    };
    await ctx.store.upsert(doc);
    await idem.remember(runId);
    res.status(202).json(accepted(runId));
    launch(ws, runId, false);
  });

  router.get('/api/runs/:id/events', async (req, res) => {
    const ws = wsOf(req);
    const id = req.params.id;
    let run = await loadRun(ws, id);
    if (run.status === 'running' && !hub.isActive(id)) {
      // 재시작 등으로 실행기가 사라진 고아 실행
      run = await ctx.store.upsert({ ...run, status: 'failed', stage: 'done', failureCode: 'interrupted' });
      await hub.emit(ws, id, 'run.failed', { code: 'interrupted', status: 'failed', retryable: true });
    }
    await hub.serve(req, res, ws, id, {
      terminalNames: TERMINAL_RUN_EVENTS,
      alreadyFinished: async () => (await ctx.store.get<ErunDoc>(ws, `erun:${id}`))?.status !== 'running',
    });
  });

  router.post('/api/runs/:id/cancel', async (req, res) => {
    const ws = wsOf(req);
    const run = await loadRun(ws, req.params.id);
    if (run.status !== 'running') { res.json({ status: run.status }); return; }
    if (!cancelActive(run.evaluationRunId)) {
      await ctx.store.upsert({ ...run, status: 'cancelled', stage: 'done', failureCode: 'cancelled' });
      await hub.emit(ws, run.evaluationRunId, 'run.failed', { code: 'cancelled', status: 'cancelled', retryable: false });
    }
    res.status(202).json({ status: 'cancelling' });
  });

  router.get('/api/runs/:id', async (req, res) => {
    const ws = wsOf(req);
    const run = await loadRun(ws, req.params.id);
    const verdicts = await ctx.store.list<any>(ws, 'verdict', `verdict:${run.evaluationRunId}:`);
    const items = run.collectionRunId ? await ctx.store.list<any>(ws, 'item', `item:${run.collectionRunId}:`) : [];
    const byKey = new Map(items.map((i) => [String(i.sourceItemKey ?? i.itemKey ?? i.id.split(':').slice(2).join(':')), i]));
    res.json({
      run,
      id: run.evaluationRunId, status: run.status, stage: run.stage, failureCode: run.failureCode, failureSummary: run.failureSummary, collectionStatus: run.collectionStatus,
      contractId: run.contractId, contractVersion: run.contractVersion, baseRunId: run.baseRunId ?? null,
      startedAt: run.createdAt, total: run.itemCount,
      verdicts: verdicts.map((v) => {
        const it = byKey.get(v.itemKey);
        return {
          ...v, effectiveDecision: effective(v), etag: v._etag,
          criteria: (v.criteria ?? []).map((c: any) => ({ ...c, criterionId: c.criterionId ?? c.id })),
          fields: it?.fields, detailUrl: it?.fields?.detailUrl ?? undefined,
          item: it ? { fields: it.fields, injectionSuspected: !!it.injectionSuspected, detailUrl: it.fields?.detailUrl } : undefined,
        };
      }),
    });
  });

  router.patch('/api/runs/:id/verdicts/:itemKey', json, async (req, res) => {
    const ws = wsOf(req);
    const run = await loadRun(ws, req.params.id);
    const decision = req.body?.decision;
    if (!['pass', 'reject', 'hold'].includes(decision)) invalid('decision은 pass, reject, hold 중 하나예요');
    const ifMatch = req.header('If-Match');
    if (!ifMatch) throw new ApiError(428, 'precondition_required', 'If-Match 헤더가 필요해요');
    const cur = await ctx.store.get<any>(ws, `verdict:${run.evaluationRunId}:${req.params.itemKey}`);
    if (!cur) notFound();
    const next = await ctx.store.replaceIfMatch({
      ...cur, manual: { decision, note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined, at: new Date().toISOString() },
    }, ifMatch.replace(/^W\//, '').replace(/"/g, ''));
    if (next._etag) res.setHeader('ETag', `"${next._etag}"`);
    res.json({ ...next, effectiveDecision: effective(next), etag: next._etag });
  });

  router.post('/api/runs/:id/reevaluate', json, async (req, res) => {
    const ws = wsOf(req);
    const base = await loadRun(ws, req.params.id);
    const idem = await idempotent(ctx, req, 'reeval');
    if (idem.existing) { res.status(200).json(accepted(idem.existing)); return; }
    if (!base.collectionRunId || base.itemCount === 0) throw new ApiError(409, 'no_collection', '재평가할 수집 결과가 없어요');
    ctx.assertRunAllowed(ws);
    const b = req.body ?? {};
    const resumeId = typeof b.resumeId === 'string' ? b.resumeId : base.resumeId;
    const criteria = await resolveCriteria(ws, b, base.criteriaSetId);
    const resumeDoc = await ctx.store.get(ws, `resume:${resumeId}`);
    if (!criteria || !resumeDoc) notFound();
    const criteriaSetId = String((criteria as any).criteriaSetId);
    const runId = newRunId();
    await ctx.store.upsert<ErunDoc>({
      id: `erun:${runId}`, type: 'evaluationRun', workspaceId: ws, evaluationRunId: runId,
      collectionRunId: base.collectionRunId, contractId: base.contractId, contractVersion: base.contractVersion,
      criteriaSetId, criteriaVersion: Number((criteria as any).version ?? 1), resumeId, ...inputSnapshot(criteria, resumeDoc), baseRunId: base.evaluationRunId,
      status: 'running', stage: 'evaluate', verdictCount: 0, itemCount: base.itemCount,
      traceId: newTrace(), createdAt: new Date().toISOString(), limits: limitsOf(), ttl: 604800,
    });
    await idem.remember(runId);
    res.status(202).json(accepted(runId, { baseRunId: base.evaluationRunId }));
    launch(ws, runId, true);
  });

  router.get('/api/runs/:id/diff', async (req, res) => {
    const ws = wsOf(req);
    const run = await loadRun(ws, req.params.id);
    const baseId = typeof req.query.base === 'string' ? req.query.base : run.baseRunId;
    if (!baseId) invalid('base 실행 ID가 필요해요');
    const base = await loadRun(ws, baseId!);
    const [cur, prev] = await Promise.all([
      ctx.store.list<any>(ws, 'verdict', `verdict:${run.evaluationRunId}:`),
      ctx.store.list<any>(ws, 'verdict', `verdict:${base.evaluationRunId}:`),
    ]);
    const prevBy = new Map(prev.map((v) => [v.itemKey, v]));
    const curBy = new Map(cur.map((v) => [v.itemKey, v]));
    const keys = new Set([...prevBy.keys(), ...curBy.keys()]);
    const changes = [...keys].map((itemKey) => {
      const a = prevBy.get(itemKey), c = curBy.get(itemKey);
      return { itemKey, before: a ? effective(a) : null, after: c ? effective(c) : null, holdReasonsBefore: a?.holdReasons ?? [], holdReasonsAfter: c?.holdReasons ?? [] };
    });
    res.json({
      runId: run.evaluationRunId, baseRunId: base.evaluationRunId,
      changed: changes.filter((c) => c.before !== c.after), unchanged: changes.filter((c) => c.before === c.after).map((c) => c.itemKey),
    });
  });
};

export default register;
