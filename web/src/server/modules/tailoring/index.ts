import express from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, type RegisterModule, type Doc, type AppContext } from '../../context.js';
import { getHub, idempotent, invalid, notFound, str, wsOf } from '../runs/common.js';
import { evaluatorJson, evaluatorStream, newTraceId } from '../runs/evaluatorClient.js';
import { loadItems } from '../runs/collectorAdapter.js';
import { confirmedFacts } from '../runs/criteriaMap.js';
import { assemble, buildChanges, renderMarkdown, type Change, type Decisions, type Original, type Sentence } from './assemble.js';

const MAX_PER_RUN = 3;
const TERMINAL = ['tailoring.completed', 'tailoring.failed'];

interface TailoringDoc extends Doc {
  tailoringId: string; evaluationRunId: string; itemKey: string; resumeId: string;
  head: { title: string; company: string; url?: string };
  originals: Original[]; request: Record<string, any>; sentences: Sentence[]; changes: Change[]; decisions: Decisions;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed';
  finalApproved: boolean; finalMarkdown?: string; traceId: string; createdAt: string; failureCode?: string;
}

const withAliases = (c: Change) => ({ ...c, id: c.changeId, type: c.kind });

// 평가기가 요구하는 요구사항 목록: 판정에서 AI가 읽은 요건/의미 기준을 쓴다.
function requirementsOf(verdict: any, criteria: any) {
  const fromVerdict = ((verdict?.criteria as any[]) ?? [])
    .filter((c) => c.source === 'ai' && c.id !== 'qual:default' && c.label)
    .map((c) => ({ id: String(c.id), text: String(c.label), skills: [] as string[] }));
  if (fromVerdict.length) return fromVerdict;
  return ((criteria?.semanticCards as any[]) ?? []).map((c) => ({ id: `sem:${c.id}`, text: String(c.text), skills: [] as string[] }));
}

// 결정 입력: [{changeId, decision}] 또는 {changeId: decision}.
function parseDecisions(raw: unknown): [string, unknown][] {
  if (Array.isArray(raw)) return raw.map((d: any) => [String(d?.changeId ?? d?.id), d?.decision]);
  if (raw && typeof raw === 'object') return Object.entries(raw);
  return invalid('decisions 형식이 올바르지 않아요');
}

const register: RegisterModule = (router, ctx) => {
  const json = express.json({ limit: '256kb' });
  const hub = getHub(ctx);
  const active = new Set<string>();

  const load = async (ws: string, id: string) => {
    const d = await ctx.store.get<TailoringDoc>(ws, `tailoring:${id}`);
    if (!d) notFound();
    return d!;
  };
  const save = async (d: TailoringDoc) => ctx.store.upsert(d);
  const patch = async (ws: string, id: string, fn: (d: TailoringDoc) => void) => {
    const d = await load(ws, id);
    fn(d);
    return save(d);
  };

  const mergeVerification = (d: TailoringDoc, results: any[]) => {
    for (const r of results ?? []) {
      const s = d.sentences.find((x) => x.sentenceId === (r.sentenceId ?? r.id));
      if (!s) continue;
      s.status = r.status === 'verified' ? 'verified' : 'unsupported';
      s.reasons = r.reasons ?? r.reasonCodes ?? [];
    }
  };

  // 평가기 SSE를 허브로 중계하면서 문서 상태를 갱신한다.
  const relay = async (ws: string, id: string, stream: AsyncIterable<{ event: string; data: Record<string, any> }>) => {
    for await (const ev of stream) {
      if (ev.event === 'heartbeat') continue;
      const { runId: _r, seq: _s, ...data } = ev.data;
      let extra: Record<string, unknown> = { tailoringId: id };
      if (ev.event === 'draft.completed') {
        await patch(ws, id, (d) => {
          d.sentences = (data.sentences ?? []).map((s: any) => ({ ...s, status: s.status ?? 'pending' }));
          d.changes = buildChanges(d.originals, d.sentences);
        });
        extra = { ...extra, originals: (await load(ws, id)).originals };
      } else if (ev.event === 'verification.result') {
        await patch(ws, id, (d) => mergeVerification(d, data.results ?? data.sentences ?? []));
      } else if (ev.event === 'approval.requested') {
        const d = await patch(ws, id, (x) => {
          x.status = 'awaiting_approval';
          // 평가기가 보낸 변경 목록(C-S1, C-O3)을 그대로 쓰고, 없으면 같은 규칙으로 직접 만든다.
          x.changes = Array.isArray(data.changes) ? data.changes : buildChanges(x.originals, x.sentences);
        });
        extra = { ...extra, changes: d.changes.map(withAliases), sentences: d.sentences, originals: d.originals };
      } else if (ev.event === 'tailoring.completed') {
        await patch(ws, id, (d) => { d.status = 'completed'; if (typeof data.markdown === 'string') d.finalMarkdown = data.markdown; });
      } else if (ev.event === 'tailoring.failed') {
        await patch(ws, id, (d) => { d.status = 'failed'; d.failureCode = String(data.code ?? 'failed'); });
      }
      await hub.emit(ws, id, ev.event, { ...data, ...extra });
    }
  };

  const runWorkflow = async (ws: string, id: string, body: unknown, traceId: string) => {
    active.add(id);
    try {
      await relay(ws, id, evaluatorStream(ctx.config.evaluatorUrl, '/internal/tailorings', { body, traceId }));
    } catch (e) {
      const code = (e as ApiError).code ?? 'internal_error';
      await patch(ws, id, (d) => { d.status = 'failed'; d.failureCode = code; });
      await hub.emit(ws, id, 'tailoring.failed', { tailoringId: id, code, retryable: code === 'evaluator_unavailable' });
    } finally {
      active.delete(id);
      hub.close(id);
    }
  };

  router.post('/api/runs/:id/tailorings', json, async (req, res) => {
    const ws = wsOf(req);
    const run = await ctx.store.get<any>(ws, `erun:${req.params.id}`);
    if (!run) notFound();
    const idem = await idempotent(ctx, req, `tailoring:${run.evaluationRunId}`);
    if (idem.existing) { res.status(200).json({ id: idem.existing, tailoringId: idem.existing }); return; }
    const itemKey = str(req.body?.itemKey, 'itemKey');
    const verdict = await ctx.store.get<any>(ws, `verdict:${run.evaluationRunId}:${itemKey}`);
    if (!verdict) notFound();
    if ((verdict.manual?.decision ?? verdict.decision) !== 'pass') invalid('pass 공고만 맞춤 이력서를 만들 수 있어요');
    const existing = await ctx.store.list(ws, 'tailoring', 'tailoring:');
    if (existing.filter((t: any) => t.evaluationRunId === run.evaluationRunId).length >= MAX_PER_RUN) {
      throw new ApiError(429, 'limit_exceeded', `실행당 맞춤 이력서는 ${MAX_PER_RUN}개까지 만들 수 있어요`);
    }
    const resume = await ctx.store.get<any>(ws, `resume:${run.resumeId}`);
    const criteria = await ctx.store.get<any>(ws, `criteria:${run.criteriaSetId}:v${run.criteriaVersion}`);
    if (!resume || !criteria) notFound();
    const items = await loadItems(ctx, ws, run.collectionRunId);
    const item = items.find((i) => i.itemKey === itemKey);
    if (!item) notFound();
    const blob = item!.detailBlob ? await ctx.blobs.get(item!.detailBlob).catch(() => undefined) : undefined;

    const originals: Original[] = (resume.sentences ?? resume.originalSentences ?? []) as Original[];
    const tailoringId = `tl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const f = item!.fields as Record<string, any>;
    const doc: TailoringDoc = {
      id: `tailoring:${tailoringId}`, type: 'tailoring', workspaceId: ws, tailoringId,
      evaluationRunId: run.evaluationRunId, itemKey, resumeId: run.resumeId,
      head: { title: String(f.title ?? ''), company: String(f.company ?? ''), url: f.detailUrl ? String(f.detailUrl) : undefined },
      originals, request: {}, sentences: [], changes: [], decisions: {}, status: 'running', finalApproved: false,
      traceId: newTraceId(), createdAt: new Date().toISOString(), ttl: 604800,
    };
    const company = String(f.company ?? '');
    doc.request = {
      tailoringId, runId: run.evaluationRunId,
      posting: {
        itemKey, title: String(f.title ?? ''), company, url: f.detailUrl ? String(f.detailUrl) : '',
        excerpt: (blob?.data.toString('utf8') ?? '').slice(0, 6000),
      },
      requirements: requirementsOf(verdict, criteria),
      facts: confirmedFacts(resume),
      originalSentences: originals,
      companyNames: items.map((i) => String(i.fields.company ?? '')).filter((n) => n && n !== company),
    };
    await save(doc);
    await idem.remember(tailoringId);
    res.status(202).json({ id: tailoringId, tailoringId, eventsUrl: `/api/tailorings/${tailoringId}/events` });
    void runWorkflow(ws, tailoringId, doc.request, doc.traceId);
  });

  router.get('/api/tailorings/:id/events', async (req, res) => {
    const ws = wsOf(req);
    const id = req.params.id;
    await load(ws, id);
    await hub.serve(req, res, ws, id, {
      terminalNames: TERMINAL,
      alreadyFinished: async () => ['completed', 'failed'].includes((await ctx.store.get<TailoringDoc>(ws, `tailoring:${id}`))?.status ?? 'failed'),
    });
  });

  const factsOf = async (ws: string, resumeId: string) => (await ctx.store.get<any>(ws, `resume:${resumeId}`));

  const reverify = async (ws: string, d: TailoringDoc, sentences: Sentence[]) => {
    const resume = await factsOf(ws, d.resumeId);
    const out = await evaluatorJson<any>(ctx.config.evaluatorUrl, '/internal/verify-sentences', {
      traceId: d.traceId,
      body: {
        sentences, facts: confirmedFacts(resume), requirements: d.request.requirements ?? [],
        companyNames: [...(d.request.companyNames ?? []), d.request.posting?.company].filter(Boolean),
      },
    });
    mergeVerification(d, out.results ?? []);
  };

  router.post('/api/tailorings/:id/sentences/:sid', json, async (req, res) => {
    const ws = wsOf(req);
    const d = await load(ws, req.params.id);
    const s = d.sentences.find((x) => x.sentenceId === req.params.sid);
    if (!s) notFound();
    const b = req.body ?? {};
    if (typeof b.text === 'string') {
      if (!b.text.trim() || b.text.length > 1000) invalid('문장은 1~1000자여야 해요');
      s!.text = b.text.trim();
      s!.status = 'pending';
    }
    let addedFact: unknown;
    if (b.addFact && typeof b.addFact === 'object') {
      const text = String(b.addFact.text ?? '').trim();
      if (!text || text.length > 500) invalid('추가할 사실을 입력해 주세요');
      const resume = await factsOf(ws, d.resumeId);
      if (!resume) notFound();
      const facts = [...(resume.facts ?? [])];
      const n = facts.filter((f: any) => f.origin === 'user').length + 1;
      addedFact = {
        id: `U${n}`, text, org: b.addFact.org, role: b.addFact.role, period: b.addFact.period,
        skills: Array.isArray(b.addFact.skills) ? b.addFact.skills : [], numbers: Array.isArray(b.addFact.numbers) ? b.addFact.numbers : [],
        origin: 'user', confirmed: true,
      };
      facts.push(addedFact);
      await ctx.store.upsert({ ...resume, facts });
      s!.sourceFactIds = [...new Set([...(s!.sourceFactIds ?? []), (addedFact as any).id])];
      s!.status = 'pending';
    }
    if (s!.status === 'pending' || b.reverify) await reverify(ws, d, [s!]);
    d.changes = buildChanges(d.originals, d.sentences);
    // 최종 승인 뒤 다시 고치면 승인을 풀고 다시 조립한다.
    if (d.finalApproved) { d.finalApproved = false; d.finalMarkdown = undefined; }
    await save(d);
    res.json({
      sentence: s, addedFact, changes: d.changes.map(withAliases),
      verification: { sentenceId: s!.sentenceId, status: s!.status === 'verified' ? 'verified' : 'unsupported', reasons: s!.reasons ?? [] },
    });
  });

  const finalMarkdown = (d: TailoringDoc) => renderMarkdown(
    { ...d.head, generatedAt: new Date().toISOString() },
    assemble(d.originals, d.sentences, d.decisions),
  );
  const decisionList = (d: TailoringDoc) => Object.entries(d.decisions).map(([changeId, decision]) => ({ changeId, decision }));

  router.post('/api/tailorings/:id/decisions', json, async (req, res) => {
    const ws = wsOf(req);
    const d = await load(ws, req.params.id);
    for (const [cid, v] of parseDecisions(req.body?.decisions ?? {})) {
      if (v !== 'accept' && v !== 'reject') invalid('결정은 accept 또는 reject예요');
      const ch = d.changes.find((c) => c.changeId === cid);
      if (!ch) invalid(`알 수 없는 변경이에요: ${cid}`);
      if (!ch!.requiresDecision) continue;
      const s = ch!.sentenceId ? d.sentences.find((x) => x.sentenceId === ch!.sentenceId) : undefined;
      if (v === 'accept' && s && s.status !== 'verified') invalid('원본에 없는 내용은 고치거나 근거를 추가한 뒤에 수락할 수 있어요');
      d.decisions[cid] = v as 'accept' | 'reject';
    }
    if (req.body?.approve !== true && req.body?.finalApproval !== true) {
      await save(d);
      res.json({ decisions: d.decisions, status: d.status });
      return;
    }

    // 최종 승인: 대기 중인 워크플로를 재개하고, 없으면 평가기 finalize, 그것도 안 되면 같은 규칙으로 웹이 조립한다.
    d.finalApproved = true;
    await save(d);
    let markdown: string | undefined;
    let completedByStream = false;
    try {
      await relay(ws, d.tailoringId, evaluatorStream(ctx.config.evaluatorUrl, `/internal/tailorings/${d.tailoringId}/responses`, {
        traceId: d.traceId, body: { decisions: decisionList(d), sentences: d.sentences },
      }));
      completedByStream = true;
      markdown = (await load(ws, d.tailoringId)).finalMarkdown;
    } catch {
      try {
        const out = await evaluatorJson<any>(ctx.config.evaluatorUrl, `/internal/tailorings/${d.tailoringId}/finalize`, {
          traceId: d.traceId, body: { ...d.request, sentences: d.sentences, decisions: decisionList(d) },
        });
        if (typeof out?.markdown === 'string') markdown = out.markdown;
      } catch { /* 평가기 없이도 웹이 같은 규칙으로 조립한다 */ }
    }
    const fresh = await load(ws, d.tailoringId);
    fresh.decisions = d.decisions;
    fresh.finalApproved = true;
    fresh.finalMarkdown = markdown ?? finalMarkdown(fresh);
    fresh.status = 'completed';
    await save(fresh);
    if (!completedByStream) await hub.emit(ws, fresh.tailoringId, 'tailoring.completed', { tailoringId: fresh.tailoringId, markdown: fresh.finalMarkdown });
    hub.close(fresh.tailoringId);
    res.json({ decisions: fresh.decisions, status: fresh.status, markdown: fresh.finalMarkdown });
  });

  router.get('/api/tailorings/:id/export', async (req, res) => {
    const ws = wsOf(req);
    const d = await load(ws, req.params.id);
    if ((req.query.format ?? 'md') !== 'md') invalid('format=md만 지원해요');
    const md = d.finalApproved && d.finalMarkdown ? d.finalMarkdown : finalMarkdown(d);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tailored-resume-${d.tailoringId}.md"`);
    res.send(md);
  });

  router.get('/api/tailorings/:id', async (req, res) => {
    const d = await load(wsOf(req), req.params.id);
    res.json({ ...d, id: d.tailoringId, changes: d.changes.map(withAliases) });
  });

  router.get('/api/workflow-graph', async (_req, res) => {
    const out = await evaluatorJson<any>(ctx.config.evaluatorUrl, '/internal/workflow-graph', { method: 'GET' });
    res.json(out);
  });
};

export default register;
