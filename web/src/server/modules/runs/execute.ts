import { createHash, randomUUID } from 'node:crypto';
import type { AppContext, Doc } from '../../context.js';
import { runCollection, loadItems, type CollectedItem } from './collectorAdapter.js';
import { evaluatorStream, newTraceId } from './evaluatorClient.js';
import { getHub } from './common.js';
import { computeCareerYears } from '../resume/logic.js';
import { confirmedFacts, toConditions } from './criteriaMap.js';

export const MAX_EXCERPT = 6000;
export const TERMINAL_RUN_EVENTS = ['run.completed', 'run.failed'];
const FORWARD = new Set(['executor.started', 'executor.completed', 'verdict.partial', 'review.changed', 'verdict.final']);

export interface ErunDoc extends Doc {
  evaluationRunId: string;
  collectionRunId?: string;
  contractId?: string; contractVersion?: number;
  criteriaSetId: string; criteriaVersion?: number;
  resumeId: string;
  criteriaHash?: string; resumeVersion?: string; resumeHash?: string;
  failureSummary?: { total: number; missing: number; byReason: Record<string, number> };
  baseRunId?: string;
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  stage: 'collect' | 'evaluate' | 'review' | 'done';
  verdictCount: number;
  itemCount: number;
  failureCode?: string;
  collectionStatus?: 'success' | 'empty' | 'failed';
  traceId: string;
  createdAt: string;
  limits: Record<string, number>;
}

const active = new Map<string, AbortController>();
export function cancelActive(runId: string): boolean {
  const c = active.get(runId);
  if (!c) return false;
  c.abort(new Error('cancelled'));
  return true;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashJson = (v: unknown) => sha256(JSON.stringify(v ?? null));
// 실행 입력 스냅샷: 조건 버전·해시와 확인된 사실의 해시.
export function inputSnapshot(criteria: any, resume: any) {
  return {
    criteriaHash: hashJson({ r: criteria?.ruleCards, s: criteria?.semanticCards }),
    resumeVersion: String(resume?._etag ?? ''),
    resumeHash: hashJson(confirmedFacts(resume)),
  };
}
export const newRunId = () => `erun_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

async function patchErun(ctx: AppContext, ws: string, runId: string, patch: Partial<ErunDoc>): Promise<void> {
  const cur = await ctx.store.get<ErunDoc>(ws, `erun:${runId}`);
  if (cur) await ctx.store.upsert({ ...cur, ...patch });
}

export async function buildEvalItems(ctx: AppContext, ws: string, items: CollectedItem[]) {
  return Promise.all(items.map(async (it) => {
    let text = '';
    if (it.detailBlob) {
      const b = await ctx.blobs.get(it.detailBlob).catch(() => undefined);
      text = b?.data.toString('utf8') ?? '';
    }
    if (!text) text = Object.entries(it.fields).map(([k, v]) => `${k}: ${v ?? ''}`).join('\n');
    const truncated = text.length > MAX_EXCERPT;
    const excerpt = truncated ? text.slice(0, MAX_EXCERPT) : text;
    const fields = Object.fromEntries(Object.entries(it.fields).map(([k, v]) => [k, v ?? '']));
    return {
      itemKey: it.itemKey, fields, url: fields.detailUrl || undefined, excerpt, excerptSha256: sha256(excerpt),
      truncated, detailMissing: it.detailMissing, injectionSuspected: it.injectionSuspected,
    };
  }));
}

export interface StartParams {
  ws: string;
  runId: string;
  reuseCollection: boolean;
}

// 실행 본체. 백그라운드에서 돌며 이벤트를 허브에 낸다.
export async function executeRun(ctx: AppContext, p: StartParams): Promise<void> {
  const { ws, runId } = p;
  const hub = getHub(ctx);
  const emit = (name: string, data: Record<string, unknown> = {}) => hub.emit(ws, runId, name, data);
  const erun = await ctx.store.get<ErunDoc>(ws, `erun:${runId}`);
  if (!erun) return;

  const controller = new AbortController();
  active.set(runId, controller);
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ctx.config.limits.runSeconds * 1000);
  timer.unref?.();
  const reason = () => (controller.signal.reason as Error | undefined)?.message;
  const emitted = new Set<string>();
  let items: CollectedItem[] = [];

  const fail = async (code: string, status: 'failed' | 'cancelled' = 'failed') => {
    await patchErun(ctx, ws, runId, { status, stage: 'done', failureCode: code });
    await emit('run.failed', { code, status, retryable: code === 'evaluator_unavailable' });
  };

  try {
    await emit('run.started', { limits: erun.limits });
    // 1) 수집
    await patchErun(ctx, ws, runId, { stage: 'collect' });
    await emit('stage.changed', { stage: 'collect' });
    if (p.reuseCollection) {
      items = await loadItems(ctx, ws, erun.collectionRunId!, ctx.config.limits.maxItems);
    } else {
      const contract = await ctx.store.get(ws, `contract:${erun.contractId}:v${erun.contractVersion}`);
      if (!contract) return await fail('contract_not_found');
      const res = await runCollection(ctx, {
        workspaceId: ws, contract, collectionRunId: erun.collectionRunId!, signal: controller.signal,
        limits: { maxItems: ctx.config.limits.maxItems, maxDetails: ctx.config.limits.maxDetails, timeoutSeconds: ctx.config.limits.runSeconds },
        onProgress: (done, total) => { void emit('collect.progress', { done, total }); },
      });
      if (res.status === 'failed') {
        await patchErun(ctx, ws, runId, { collectionStatus: 'failed' });
        return await fail(res.failureCode ?? 'collection_failed');
      }
      items = res.items;
    }
    await patchErun(ctx, ws, runId, { collectionStatus: items.length ? 'success' : 'empty' });
    if (controller.signal.aborted) return await fail(reason() === 'cancelled' ? 'cancelled' : 'timeout', reason() === 'cancelled' ? 'cancelled' : 'failed');
    for (const it of items) {
      emitted.add(it.itemKey);
      await emit('item.collected', { itemKey: it.itemKey, summary: it.fields, injectionSuspected: it.injectionSuspected, detailMissing: it.detailMissing });
    }
    await emit('collect.progress', { done: items.length, total: items.length });
    await patchErun(ctx, ws, runId, { itemCount: items.length });

    // 2) 평가
    await patchErun(ctx, ws, runId, { stage: 'evaluate' });
    await emit('stage.changed', { stage: 'evaluate' });
    const criteria = await ctx.store.get<any>(ws, `criteria:${erun.criteriaSetId}:v${erun.criteriaVersion}`);
    const resume = await ctx.store.get<any>(ws, `resume:${erun.resumeId}`);
    if (!criteria || !resume) return await fail('input_not_found');
    const evalItems = await buildEvalItems(ctx, ws, items);
    const finals = new Set<string>();
    const reviews = new Map<string, { from: unknown; to: unknown; reason?: unknown }>();
    let reviewStage = false;
    let evalError: string | undefined;
    try {
      const stream = evaluatorStream(ctx.config.evaluatorUrl, '/internal/evaluations', {
        traceId: erun.traceId, signal: controller.signal,
        body: {
          runId, items: evalItems, conditions: toConditions(criteria),
          facts: confirmedFacts(resume),
          experienceYears: (() => {
            const periods = confirmedFacts(resume).filter((f: any) => f.category === 'experience' && f.period).map((f: any) => f.period);
            return periods.length ? computeCareerYears(periods) : (resume.careerYears ?? 0);
          })(),
          limits: {
            modelCalls: ctx.config.limits.modelCalls, runSeconds: ctx.config.limits.runSeconds,
            itemSeconds: Math.min(90, ctx.config.limits.runSeconds), agentSeconds: Math.min(60, ctx.config.limits.runSeconds), concurrency: 3,
          },
        },
      });
      for await (const ev of stream) {
        const { runId: _r, seq: _s, ...data } = ev.data;
        if (ev.event === 'run.failed') { evalError = String(data.code ?? 'evaluation_failed'); continue; }
        if (!FORWARD.has(ev.event)) continue;
        if (Array.isArray(data.criteria)) data.criteria = data.criteria.map((c: any) => ({ ...c, criterionId: c.criterionId ?? c.id }));
        if (ev.event === 'review.changed' && data.itemKey) reviews.set(String(data.itemKey), { from: data.before, to: data.after, reason: data.reason });
        if (ev.event === 'executor.started' && /review/i.test(String(data.executor ?? data.name ?? '')) && !reviewStage) {
          reviewStage = true;
          await patchErun(ctx, ws, runId, { stage: 'review' });
          await emit('stage.changed', { stage: 'review' });
        }
        if (ev.event === 'verdict.final' && data.itemKey) {
          const itemKey = String(data.itemKey);
          finals.add(itemKey);
          await ctx.store.upsert({
            id: `verdict:${runId}:${itemKey}`, type: 'verdict', workspaceId: ws, evaluationRunId: runId, itemKey,
            decision: data.decision, source: data.source, holdReasons: data.holdReasons ?? [],
            criteria: data.criteria ?? [],
            reviewChange: reviews.get(itemKey),
            excerptSha256: data.excerptSha256 ?? evalItems.find((i) => i.itemKey === itemKey)?.excerptSha256,
            injectionSuspected: data.injectionSuspected ?? items.find((i) => i.itemKey === itemKey)?.injectionSuspected ?? false,
            updatedAt: new Date().toISOString(),
          } as Doc);
        }
        await emit(ev.event, data);
      }
    } catch (e) {
      if (controller.signal.aborted) {
        if (reason() === 'cancelled') return await fail('cancelled', 'cancelled');
        evalError = 'timeout';
      } else {
        evalError = (e as { code?: string }).code ?? 'evaluator_unavailable';
      }
    }

    // 남은 공고는 한도·오류 사유 hold로 채운다.
    const missing = evalItems.filter((i) => !finals.has(i.itemKey));
    if (evalError === 'evaluator_unavailable') return await fail(evalError);
    if (evalError && finals.size === 0 && evalError !== 'timeout') return await fail(evalError);
    for (const it of missing) {
      const holdReason = evalError === 'timeout' ? 'timeout' : 'limit_reached';
      await ctx.store.upsert({
        id: `verdict:${runId}:${it.itemKey}`, type: 'verdict', workspaceId: ws, evaluationRunId: runId, itemKey: it.itemKey,
        decision: 'hold', holdReasons: [holdReason], criteria: [], excerptSha256: it.excerptSha256,
        injectionSuspected: it.injectionSuspected, updatedAt: new Date().toISOString(),
      } as Doc);
      await emit('verdict.final', { itemKey: it.itemKey, decision: 'hold', holdReasons: [holdReason], criteria: [] });
    }

    const byReason: Record<string, number> = {};
    if (missing.length) byReason[evalError === 'timeout' ? 'timeout' : 'limit_reached'] = missing.length;
    const partial = missing.length > 0;
    await patchErun(ctx, ws, runId, {
      status: partial ? 'partial' : 'completed', stage: 'done', verdictCount: items.length,
      ...(partial ? { failureSummary: { total: items.length, missing: missing.length, byReason } } : {}),
    });
    await emit('stage.changed', { stage: 'done' });
    await emit('run.completed', { verdictCount: items.length, status: partial ? 'partial' : 'completed', ...(partial ? { failureSummary: { total: items.length, missing: missing.length, byReason } } : {}) });
  } catch (e) {
    if (controller.signal.aborted) {
      await fail(reason() === 'cancelled' ? 'cancelled' : 'timeout', reason() === 'cancelled' ? 'cancelled' : 'failed');
    } else {
      await fail((e as { code?: string }).code ?? 'internal_error');
    }
  } finally {
    clearTimeout(timer);
    active.delete(runId);
    hub.close(runId);
  }
}

export function newTrace(): string { return newTraceId(); }
