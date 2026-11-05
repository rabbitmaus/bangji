import { randomUUID } from 'node:crypto';
import { ApiError, type AppContext, type Doc } from '../../context.js';
import { getHub, latestVersioned } from '../runs/common.js';
import { runCollection } from '../runs/collectorAdapter.js';
import { evaluatorStream, newTraceId } from '../runs/evaluatorClient.js';
import { buildEvalItems, inputSnapshot } from '../runs/execute.js';
import { confirmedFacts, toConditions } from '../runs/criteriaMap.js';
import { computeCareerYears } from '../resume/logic.js';
import type { EdgeDef, NodeDef, WorkflowDefinition } from './schema.js';
import { getWorkflowDoc, type WorkflowDoc } from './store.js';
import { canonicalHash, topologicalOrder, validateDefinition } from './validate.js';
import * as N from './executorNodes.js';
import {
  copyNodeOutput, emptyNode, getWfRun, loadNodeOutput, newWfRunId, saveNodeOutput, saveWfRun, wfRunDocId,
  type WfNodeState, type WfRunDoc,
} from './nodeRuns.js';

export const WF_TERMINAL_EVENTS = ['workflow.completed', 'workflow.failed', 'workflow.waiting'];
export const DEFAULT_SAMPLE_ITEMS = 3;
export const MAX_SAMPLE_ITEMS = 10;
const SAMPLE_MODEL_CALLS = 10;
const SAMPLE_RUN_SECONDS = 90;

export interface RunOptions { mode: 'sample' | 'full'; sampleItems?: number }

class NodeError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

const active = new Map<string, AbortController>();
export const isWorkflowRunActive = (runId: string) => active.has(runId);
export function cancelWorkflowRun(runId: string): boolean {
  const c = active.get(runId);
  if (!c) return false;
  c.abort(new Error('cancelled'));
  return true;
}

const latestOf = <T extends Doc>(docs: T[]) => [...docs].sort((a, b) => String(b.createdAt ?? b.updatedAt ?? '').localeCompare(String(a.createdAt ?? a.updatedAt ?? '')))[0];

async function resolveCriteria(ctx: AppContext, ws: string, id?: string): Promise<any | undefined> {
  if (id) return latestVersioned<Doc>(ctx, ws, 'criteriaSet', `criteria:${id}`);
  const docs = await ctx.store.list<any>(ws, 'criteriaSet', 'criteria:');
  return docs.sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0];
}
async function resolveResume(ctx: AppContext, ws: string, id?: string): Promise<any | undefined> {
  if (id) return ctx.store.get<any>(ws, `resume:${id}`);
  return latestOf(await ctx.store.list<any>(ws, 'resume', 'resume:'));
}

const cfgString = (def: WorkflowDefinition, key: string, kinds: string[]) => {
  for (const n of def.nodes) if (kinds.includes(n.kind) && typeof n.config[key] === 'string' && n.config[key]) return n.config[key] as string;
  return undefined;
};

function effectiveLimits(ctx: AppContext, doc: WorkflowDoc, opts: RunOptions): WfRunDoc['limits'] {
  const d = doc.definition.limits;
  const b = opts.mode === 'full' && doc.approval ? doc.approval.budget : d;
  const c = ctx.config.limits;
  const n = opts.mode === 'sample' ? Math.min(MAX_SAMPLE_ITEMS, Math.max(1, opts.sampleItems ?? DEFAULT_SAMPLE_ITEMS)) : Infinity;
  const sample = opts.mode === 'sample';
  return {
    maxItems: Math.min(d.maxItems, b.maxItems, c.maxItems, n),
    maxDetails: Math.min(d.maxDetails, b.maxDetails, c.maxDetails, n),
    maxModelCalls: Math.min(d.maxModelCalls, b.maxModelCalls, c.modelCalls, sample ? SAMPLE_MODEL_CALLS : Infinity),
    runSeconds: Math.min(d.runSeconds, b.runSeconds, c.runSeconds, sample ? SAMPLE_RUN_SECONDS : Infinity),
  };
}

function assertRunnable(doc: WorkflowDoc, mode: 'sample' | 'full', hasResumeFacts: boolean): void {
  if (mode === 'full' && (doc.status !== 'approved' || !doc.approval || canonicalHash(doc.definition) !== doc.approval.definitionHash)) {
    throw new ApiError(409, 'not_approved', '승인된 워크플로만 전체 실행할 수 있어요. 수정했다면 다시 승인해 주세요');
  }
  const v = validateDefinition(doc.definition, { hasResumeFacts });
  if (!v.ok) throw new ApiError(422, 'validation_failed', `검증 오류가 있어 실행할 수 없어요: ${v.errors[0]?.message ?? ''}`.trim());
}

export async function createWorkflowRun(ctx: AppContext, ws: string, doc: WorkflowDoc, opts: RunOptions): Promise<WfRunDoc> {
  const criteria = await resolveCriteria(ctx, ws, cfgString(doc.definition, 'criteriaSetId', ['ruleFilter', 'evidenceEvaluate']));
  const resume = await resolveResume(ctx, ws, cfgString(doc.definition, 'resumeId', ['evidenceEvaluate', 'tailor']));
  assertRunnable(doc, opts.mode, confirmedFacts(resume).length > 0);
  const runId = newWfRunId();
  const now = new Date().toISOString();
  const snap = inputSnapshot(criteria, resume);
  return saveWfRun(ctx, {
    id: wfRunDocId(runId), type: 'wfrun', workspaceId: ws, runId, workflowId: doc.workflowId, revision: doc.revision,
    definitionHash: canonicalHash(doc.definition), status: 'queued', mode: opts.mode,
    ...(opts.mode === 'sample' ? { sampleItems: Math.min(MAX_SAMPLE_ITEMS, Math.max(1, opts.sampleItems ?? DEFAULT_SAMPLE_ITEMS)) } : {}),
    nodes: Object.fromEntries(doc.definition.nodes.map((n) => [n.id, emptyNode()])),
    snapshot: {
      criteriaSetId: criteria?.criteriaSetId, criteriaVersion: criteria?.version, criteriaHash: criteria ? snap.criteriaHash : undefined,
      resumeId: resume?.resumeId, resumeVersion: resume ? snap.resumeVersion : undefined, resumeHash: resume ? snap.resumeHash : undefined,
    },
    limits: effectiveLimits(ctx, doc, opts), modelCalls: 0, reviews: {}, artifacts: {}, createdAt: now, updatedAt: now,
  });
}

function reach(edges: EdgeDef[], start: string, dir: 'down' | 'up'): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) {
      const [a, b] = dir === 'down' ? [e.from.node, e.to.node] : [e.to.node, e.from.node];
      if (a === id && !seen.has(b)) { seen.add(b); stack.push(b); }
    }
  }
  return seen;
}

// 선택 재실행: fromNodeId와 그 하위 노드만 다시 돌리고, 나머지는 이전 실행의 저장된 출력을 재사용한다.
export async function createRerun(ctx: AppContext, ws: string, prev: WfRunDoc, fromNodeId: string): Promise<WfRunDoc> {
  if (prev.status === 'running' || prev.status === 'queued' || isWorkflowRunActive(prev.runId)) throw new ApiError(409, 'run_busy', '실행이 끝난 뒤에 다시 돌릴 수 있어요');
  const wf = await getWorkflowDoc(ctx.store, ws, prev.workflowId, prev.revision);
  if (!wf || canonicalHash(wf.definition) !== prev.definitionHash) throw new ApiError(409, 'definition_changed', '실행 당시의 워크플로 정의를 찾지 못했어요');
  if (!wf.definition.nodes.some((n) => n.id === fromNodeId)) throw new ApiError(400, 'validation_failed', '다시 시작할 단계를 찾지 못했어요');
  assertRunnable(wf, prev.mode, true);
  const edges = wf.definition.edges;
  const down = reach(edges, fromNodeId, 'down');
  const up = reach(edges, fromNodeId, 'up');
  up.delete(fromNodeId);
  const runId = newWfRunId();
  const nodes: Record<string, WfNodeState> = {};
  const artifacts: WfRunDoc['artifacts'] = {};
  const reviews: WfRunDoc['reviews'] = {};
  let modelCalls = 0;
  for (const n of wf.definition.nodes) {
    const old = prev.nodes[n.id];
    if (down.has(n.id)) { nodes[n.id] = { ...emptyNode(), attempt: old?.attempt ?? 0 }; continue; }
    if (old?.status === 'completed' && (await copyNodeOutput(ctx, ws, prev.runId, runId, n.id))) {
      nodes[n.id] = old; modelCalls += old.modelCalls;
      if (prev.artifacts[n.id]) artifacts[n.id] = prev.artifacts[n.id];
      if (prev.reviews[n.id]) reviews[n.id] = prev.reviews[n.id];
    } else if (up.has(n.id)) {
      throw new ApiError(409, 'upstream_missing', `앞 단계 "${n.label ?? n.id}"의 저장된 결과가 없어 이 단계부터 다시 돌릴 수 없어요`);
    } else nodes[n.id] = emptyNode();
  }
  const now = new Date().toISOString();
  return saveWfRun(ctx, {
    ...prev, _etag: undefined, id: wfRunDocId(runId), runId, status: 'queued', nodes, artifacts, reviews, modelCalls,
    failureCode: undefined, rerunOf: prev.runId, fromNodeId, createdAt: now, updatedAt: now,
  });
}

function childSignal(parent: AbortSignal, seconds?: number) {
  const c = new AbortController();
  const onAbort = () => c.abort(parent.reason);
  if (parent.aborted) onAbort(); else parent.addEventListener('abort', onAbort, { once: true });
  const t = seconds ? setTimeout(() => c.abort(new Error('node_timeout')), seconds * 1000) : undefined;
  t?.unref?.();
  return { signal: c.signal, done: () => { if (t) clearTimeout(t); parent.removeEventListener('abort', onAbort); } };
}

const uniqueItems = (items: N.WfItem[]) => {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.itemKey) && !!seen.add(i.itemKey));
};
const countOf = (p: N.PortPayload) => (N.isItems(p) ? p.length : p.entries?.length ?? 1);
const OUTPUT_KINDS = new Set(['exportMarkdown', 'exportList']);

export async function executeWorkflowRun(ctx: AppContext, ws: string, runId: string): Promise<WfRunDoc | undefined> {
  if (active.has(runId)) return undefined;
  let run = await getWfRun(ctx, ws, runId);
  if (!run) return undefined;
  const hub = getHub(ctx);
  const emit = async (name: string, data: Record<string, unknown> = {}) => { await hub.emit(ws, runId, name, data); };
  const persist = async () => { run = await saveWfRun(ctx, run!); };
  const controller = new AbortController();
  active.set(runId, controller);
  const timer = setTimeout(() => controller.abort(new Error('timeout')), run.limits.runSeconds * 1000);
  timer.unref?.();
  const reason = () => (controller.signal.reason as Error | undefined)?.message;

  try {
    const wf = await getWorkflowDoc(ctx.store, ws, run.workflowId, run.revision);
    if (!wf || canonicalHash(wf.definition) !== run.definitionHash) {
      run = { ...run, status: 'failed', failureCode: 'definition_changed' };
      await persist();
      await emit('workflow.failed', { code: 'definition_changed', status: 'failed' });
      return run;
    }
    const def = wf.definition;
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    const incoming = new Map<string, EdgeDef[]>();
    for (const e of def.edges) (incoming.get(e.to.node) ?? incoming.set(e.to.node, []).get(e.to.node)!).push(e);
    const order = topologicalOrder(def).order;
    const outputs = new Map<string, N.NodeOutputs>();
    const L = run.limits;
    const sample = run.mode === 'sample';
    const waitingNow = () => Object.entries(run!.nodes).filter(([, s]) => s.status === 'waiting_review').map(([id]) => id);

    run = { ...run, status: 'running' };
    await persist();
    await emit('workflow.started', { mode: run.mode, sample, nodeCount: def.nodes.length, limits: L, rerunOf: run.rerunOf });

    const runNode = async (node: NodeDef, groups: N.WfItem[][], artifacts: N.WfArtifact[], signal: AbortSignal) => {
      const items = uniqueItems(groups.flat());
      const result = (o: N.NodeOutputs, extra: { modelCalls?: number; inputCount?: number; waiting?: N.WfItem[]; note?: string } = {}) =>
        ({ outputs: o, modelCalls: extra.modelCalls ?? 0, inputCount: extra.inputCount ?? items.length + artifacts.length, waiting: extra.waiting });
      const cfg = node.config;
      switch (node.kind) {
        case 'collect': {
          const contractId = typeof cfg.contractId === 'string' ? cfg.contractId : '';
          if (!contractId) throw new NodeError('contract_required', '수집 계약(contractId)이 필요해요. URL만으로 수집하는 기능은 아직 지원하지 않아요');
          const contract = await latestVersioned<Doc>(ctx, ws, 'contract', `contract:${contractId}`);
          if (!contract) throw new NodeError('contract_not_found', '수집 계약을 찾지 못했어요');
          const res = await runCollection(ctx, {
            workspaceId: ws, contract, collectionRunId: `crun_${randomUUID().replace(/-/g, '').slice(0, 12)}`, signal,
            limits: { maxItems: L.maxItems, maxDetails: L.maxDetails, timeoutSeconds: L.runSeconds },
            onProgress: (done, total) => { void emit('node.progress', { nodeId: node.id, done, total }); },
          });
          if (res.status === 'failed') throw new NodeError(res.failureCode ?? 'collection_failed', '공고 수집에 실패했어요', true);
          const out: N.WfItem[] = res.items.slice(0, L.maxItems).map((i) => ({ ...i, sources: [node.id] }));
          return result({ out }, { inputCount: 0 });
        }
        case 'mergeDedupe': {
          const keys = Array.isArray(cfg.keyFields) && cfg.keyFields.length ? (cfg.keyFields as string[]) : ['url'];
          return result({ out: N.mergeDedupe(groups, keys, L.maxItems) }, { inputCount: groups.reduce((s, g) => s + g.length, 0) });
        }
        case 'normalizeFields':
          return result({ out: N.normalizeFields(items, cfg as { renames?: Record<string, string>; dateFormat?: 'iso' | 'ymd' }) });
        case 'ruleFilter': {
          let rules = (Array.isArray(cfg.rules) ? cfg.rules : []) as N.RuleCfg[];
          if (!rules.length) {
            const c = await resolveCriteria(ctx, ws, typeof cfg.criteriaSetId === 'string' ? cfg.criteriaSetId : undefined);
            rules = ((c?.ruleCards as any[]) ?? []).map((r) => ({ criterion: r.criterion, required: r.required, params: r.params }));
          }
          return result({ out: N.ruleFilter(items, rules).kept });
        }
        case 'branch': {
          const b = N.branch(items, cfg as { on?: string; field?: string; equals?: unknown });
          return result({ true: b.t, false: b.f });
        }
        case 'evidenceEvaluate': {
          const criteria = await resolveCriteria(ctx, ws, typeof cfg.criteriaSetId === 'string' ? cfg.criteriaSetId : run!.snapshot.criteriaSetId);
          const resume = await resolveResume(ctx, ws, typeof cfg.resumeId === 'string' ? cfg.resumeId : run!.snapshot.resumeId);
          if (!criteria || !resume) throw new NodeError('input_not_found', '조건 또는 이력서를 찾지 못했어요');
          const remaining = L.maxModelCalls - run!.modelCalls;
          const target = remaining > 0 ? items.slice(0, remaining) : [];
          const overflow = items.slice(target.length);
          if (items.length && !target.length) throw new NodeError('model_budget_exceeded', '모델 호출 한도를 넘어 평가할 수 없어요');
          const finals = new Map<string, N.WfVerdict>();
          let evalError: string | undefined;
          if (target.length) {
            const evalItems = await buildEvalItems(ctx, ws, target);
            const facts = confirmedFacts(resume);
            const periods = facts.filter((f: any) => f.category === 'experience' && f.period).map((f: any) => f.period);
            try {
              const stream = evaluatorStream(ctx.config.evaluatorUrl, '/internal/evaluations', {
                traceId: newTraceId(), signal,
                body: {
                  runId, items: evalItems, conditions: toConditions(criteria), facts, experienceYears: periods.length ? computeCareerYears(periods) : 0,
                  limits: {
                    modelCalls: remaining, runSeconds: L.runSeconds, itemSeconds: Math.min(90, L.runSeconds),
                    agentSeconds: Math.min(60, L.runSeconds), concurrency: 3,
                  },
                },
              });
              for await (const ev of stream) {
                const d = ev.data as Record<string, any>;
                if (ev.event === 'run.failed') { evalError = String(d.code ?? 'evaluation_failed'); continue; }
                if (ev.event !== 'verdict.final' || !d.itemKey) continue;
                const decision = d.decision === 'pass' || d.decision === 'reject' ? d.decision : 'hold';
                finals.set(String(d.itemKey), {
                  decision, holdReasons: Array.isArray(d.holdReasons) ? d.holdReasons.map(String).slice(0, 5) : [],
                  criteria: Array.isArray(d.criteria) ? d.criteria.slice(0, 10) : [],
                });
                void emit('node.progress', { nodeId: node.id, done: finals.size, total: target.length });
              }
            } catch (e) {
              if (signal.aborted) throw e;
              evalError = (e as { code?: string }).code ?? 'evaluator_unavailable';
            }
            if (evalError === 'evaluator_unavailable' || (evalError && finals.size === 0)) throw new NodeError(evalError, '근거 평가를 진행하지 못했어요', evalError === 'evaluator_unavailable');
          }
          const out: Record<string, N.WfItem[]> = { pass: [], hold: [], reject: [] };
          for (const it of target) {
            const v = finals.get(it.itemKey) ?? { decision: 'hold' as const, holdReasons: [evalError === 'timeout' ? 'timeout' : 'limit_reached'], criteria: [] };
            out[v.decision].push({ ...it, verdict: v });
          }
          for (const it of overflow) out.hold.push({ ...it, verdict: { decision: 'hold', holdReasons: ['limit_reached'], criteria: [] } });
          return result(out, { modelCalls: target.length });
        }
        case 'humanReview': {
          const decided = run!.reviews[node.id];
          if (sample) return result({ approved: items });
          if (!items.length) return result({ approved: [] });
          if (!decided) return { ...result({}), waiting: items };
          const ok = new Set(decided.filter((d) => d.approve).map((d) => d.itemId));
          return result({ approved: items.filter((i) => ok.has(i.itemKey)) });
        }
        case 'tailor': {
          const resume = await resolveResume(ctx, ws, typeof cfg.resumeId === 'string' ? cfg.resumeId : run!.snapshot.resumeId);
          const facts = confirmedFacts(resume);
          if (!facts.length) throw new NodeError('resume_facts_required', '확인된 이력서 사실이 있어야 맞춤 단계를 실행할 수 있어요');
          const per = typeof cfg.maxPerItem === 'number' ? cfg.maxPerItem : 3;
          const entries = N.tailorSuggestions(items.slice(0, L.maxItems), facts, per);
          const art: N.WfArtifact = { kind: 'tailor', title: '이력서 맞춤 제안', entries, sample };
          return result({ out: art });
        }
        case 'exportMarkdown': {
          const src = artifacts[0];
          if (!src) throw new NodeError('input_empty', '내보낼 맞춤 결과가 없어요');
          const title = typeof cfg.title === 'string' && cfg.title ? cfg.title : '맞춤 문서';
          const art: N.WfArtifact = { kind: 'markdown', title, markdown: N.renderTailorMarkdown(title, src.entries ?? [], sample), entries: src.entries, sample };
          return result({ out: art });
        }
        case 'exportList': {
          const title = typeof cfg.title === 'string' && cfg.title ? cfg.title : '공고 목록';
          const { markdown, entries } = N.renderList(title, items, sample);
          return result({ out: { kind: 'list', title, markdown, entries, sample } satisfies N.WfArtifact });
        }
        default:
          throw new NodeError('unsupported_kind', `지원하지 않는 노드예요: ${node.kind}`);
      }
    };

    for (const id of order) {
      const node = byId.get(id)!;
      let st = run.nodes[id] ?? emptyNode();
      if (st.status === 'completed') {
        const saved = await loadNodeOutput(ctx, ws, runId, id);
        if (saved) { outputs.set(id, saved); continue; }
        st = emptyNode();
      }
      if (controller.signal.aborted) break;
      const ins = incoming.get(id) ?? [];
      const srcStatus = ins.map((e) => run!.nodes[e.from.node]?.status);
      if (ins.length && srcStatus.every((s) => s === 'failed' || s === 'skipped')) {
        run.nodes[id] = { ...st, status: 'skipped', finishedAt: new Date().toISOString() };
        await persist();
        continue;
      }
      if (srcStatus.some((s) => s === 'waiting_review' || s === 'pending' || s === 'running' || s === undefined)) {
        run.nodes[id] = { ...st, status: 'pending' };
        continue;
      }
      const groups: N.WfItem[][] = [];
      const artifacts: N.WfArtifact[] = [];
      for (const e of ins) {
        const p = outputs.get(e.from.node)?.[e.from.port];
        if (N.isItems(p)) groups.push(p); else if (N.isArtifact(p)) artifacts.push(p);
      }
      const maxTries = (node.retry?.max ?? 0) + 1;
      let attempt = st.attempt;
      let done = false;
      for (let t = 0; t < maxTries && !done; t++) {
        attempt++;
        run.nodes[id] = { ...emptyNode(), status: 'running', startedAt: new Date().toISOString(), attempt };
        await persist();
        await emit('node.started', { nodeId: id, kind: node.kind, attempt });
        const cs = childSignal(controller.signal, node.timeoutSeconds);
        try {
          const r = await runNode(node, groups, artifacts, cs.signal);
          if (cs.signal.aborted) throw cs.signal.reason;
          const now = new Date().toISOString();
          if (r.waiting) {
            const rows = N.previewItems(r.waiting, L.maxItems);
            run.nodes[id] = { ...run.nodes[id], status: 'waiting_review', inputCount: r.inputCount, preview: rows.slice(0, 3), waitingItems: rows };
            await persist();
            await emit('node.waiting', { nodeId: id, kind: node.kind, inputCount: r.inputCount, instruction: typeof node.config.instruction === 'string' ? node.config.instruction : undefined, items: rows });
            done = true;
            break;
          }
          outputs.set(id, r.outputs);
          await saveNodeOutput(ctx, ws, runId, id, r.outputs);
          const ports = Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, countOf(v)]));
          const outputCount = Object.values(ports).reduce((s, n) => s + n, 0);
          const firstPayload = Object.values(r.outputs).find((v) => (N.isItems(v) ? v.length : true));
          const preview = !firstPayload ? [] : N.isItems(firstPayload) ? N.previewItems(firstPayload) : N.previewArtifact(firstPayload);
          run.modelCalls += r.modelCalls;
          for (const v of Object.values(r.outputs)) if (N.isArtifact(v) && OUTPUT_KINDS.has(node.kind)) run.artifacts[id] = v;
          run.nodes[id] = { ...run.nodes[id], status: 'completed', finishedAt: now, inputCount: r.inputCount, outputCount, outputs: ports, preview, modelCalls: r.modelCalls };
          await persist();
          await emit('node.completed', { nodeId: id, kind: node.kind, attempt, inputCount: r.inputCount, outputCount, outputs: ports, preview, modelCalls: r.modelCalls });
          done = true;
        } catch (e) {
          if (controller.signal.aborted) { done = true; continue; }
          const err = e instanceof NodeError ? e
            : cs.signal.aborted ? new NodeError('node_timeout', '단계 제한 시간을 넘었어요', true)
            : new NodeError((e as { code?: string }).code ?? 'internal_error', '단계를 실행하지 못했어요', true);
          const final = t + 1 >= maxTries || !err.retryable;
          if (final) {
            run.nodes[id] = { ...run.nodes[id], status: 'failed', finishedAt: new Date().toISOString(), error: { code: err.code, message: err.message } };
            await persist();
            await emit('node.failed', { nodeId: id, kind: node.kind, attempt, code: err.code, message: err.message, retryable: err.retryable });
            done = true;
          }
        } finally {
          cs.done();
        }
      }
    }

    const states = Object.values(run.nodes);
    const count = (s: string) => states.filter((n) => n.status === s).length;
    const stats = {
      nodes: { total: states.length, completed: count('completed'), failed: count('failed'), skipped: count('skipped'), waiting: count('waiting_review'), pending: count('pending') },
      items: Object.fromEntries(Object.entries(run.nodes).map(([k, n]) => [k, { in: n.inputCount, out: n.outputCount }])),
      modelCalls: run.modelCalls,
    };
    if (controller.signal.aborted) {
      const cancelled = reason() === 'cancelled';
      const code = cancelled ? 'cancelled' : 'timeout';
      const now = new Date().toISOString();
      const nodes = Object.fromEntries(Object.entries(run.nodes).map(([k, n]) => [k, n.status === 'running' ? { ...n, status: 'cancelled' as const, finishedAt: now } : n]));
      run = { ...run, nodes, status: cancelled ? 'cancelled' : 'failed', failureCode: code };
      await persist();
      await emit('workflow.failed', { code, status: run.status, mode: run.mode, sample, counts: stats });
    } else if (waitingNow().length) {
      run = { ...run, status: 'waiting_review' };
      await persist();
      await emit('workflow.waiting', { nodeIds: waitingNow(), mode: run.mode, sample, counts: stats });
    } else {
      const failed = Object.entries(run.nodes).find(([, n]) => n.status === 'failed');
      const outputDone = def.nodes.some((n) => OUTPUT_KINDS.has(n.kind) && run!.nodes[n.id]?.status === 'completed');
      const status = !failed ? 'completed' : outputDone ? 'partial' : 'failed';
      run = { ...run, status, failureCode: failed?.[1].error?.code };
      await persist();
      await emit(status === 'failed' ? 'workflow.failed' : 'workflow.completed', {
        status, code: run.failureCode, mode: run.mode, sample, counts: stats, artifacts: Object.keys(run.artifacts),
      });
    }
    return run;
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'internal_error';
    run = { ...run!, status: 'failed', failureCode: code };
    await persist().catch(() => undefined);
    await emit('workflow.failed', { code, status: 'failed' }).catch(() => undefined);
    return run;
  } finally {
    clearTimeout(timer);
    active.delete(runId);
    hub.close(runId);
  }
}

// 생성과 실행을 한 번에 한다. 테스트와 내부 호출용이며 라우트는 create 후 백그라운드로 execute 한다.
export async function runWorkflow(ctx: AppContext, ws: string, doc: WorkflowDoc, opts: RunOptions): Promise<WfRunDoc> {
  const run = await createWorkflowRun(ctx, ws, doc, opts);
  return (await executeWorkflowRun(ctx, ws, run.runId)) ?? run;
}
