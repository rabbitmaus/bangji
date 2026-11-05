import express from 'express';
import type { Router } from 'express';
import { ApiError, type AppContext } from '../../context.js';
import { getHub, idempotent, invalid, notFound, wsOf } from '../runs/common.js';
import {
  cancelWorkflowRun, createRerun, createWorkflowRun, executeWorkflowRun, isWorkflowRunActive, MAX_SAMPLE_ITEMS, WF_TERMINAL_EVENTS,
} from './executor.js';
import { getWfRun, markOrphaned, saveWfRun, type WfRunDoc } from './nodeRuns.js';
import { getWorkflowDoc } from './store.js';

const view = (r: WfRunDoc) => ({
  id: r.runId, runId: r.runId, workflowId: r.workflowId, revision: r.revision, definitionHash: r.definitionHash,
  status: r.status, mode: r.mode, sample: r.mode === 'sample', sampleItems: r.sampleItems, nodes: r.nodes, artifacts: r.artifacts,
  snapshot: r.snapshot, limits: r.limits, modelCalls: r.modelCalls, failureCode: r.failureCode, rerunOf: r.rerunOf, fromNodeId: r.fromNodeId,
  waitingFor: Object.entries(r.nodes).filter(([, n]) => n.status === 'waiting_review').map(([id]) => id),
  createdAt: r.createdAt, updatedAt: r.updatedAt, eventsUrl: `/api/workflow-runs/${r.runId}/events`,
});

export function registerWorkflowRunRoutes(router: Router, ctx: AppContext): void {
  const json = express.json({ limit: '256kb' });
  const hub = getHub(ctx);

  const launch = (ws: string, runId: string) => { void executeWorkflowRun(ctx, ws, runId).catch(() => undefined); };
  const allow = (ws: string, mode: 'sample' | 'full') => {
    if (mode === 'sample' && ctx.assertPrepAllowed) ctx.assertPrepAllowed(ws); else ctx.assertRunAllowed(ws);
  };
  const load = async (ws: string, id: string) => {
    const run = await getWfRun(ctx, ws, id);
    if (!run) notFound();
    const fixed = await markOrphaned(ctx, run!, isWorkflowRunActive);
    if (fixed !== run) await hub.emit(ws, id, 'workflow.failed', { code: 'interrupted', status: 'failed', retryable: true });
    return fixed;
  };

  router.post('/api/workflow-runs', json, async (req, res) => {
    const ws = wsOf(req);
    const b = req.body ?? {};
    if (typeof b.workflowId !== 'string' || !b.workflowId) invalid('workflowId 값이 필요해요');
    if (b.mode !== 'sample' && b.mode !== 'full') invalid('mode는 sample 또는 full이에요');
    if (b.revision != null && !Number.isInteger(b.revision)) invalid('revision은 정수여야 해요');
    if (b.sampleItems != null && (!Number.isInteger(b.sampleItems) || b.sampleItems < 1 || b.sampleItems > MAX_SAMPLE_ITEMS)) invalid(`sampleItems는 1~${MAX_SAMPLE_ITEMS} 사이 정수예요`);
    const idem = await idempotent(ctx, req, 'wfrun');
    if (idem.existing) { res.status(200).json({ runId: idem.existing, eventsUrl: `/api/workflow-runs/${idem.existing}/events` }); return; }
    const doc = await getWorkflowDoc(ctx.store, ws, b.workflowId, b.revision ?? undefined);
    if (!doc) throw new ApiError(404, 'not_found', '워크플로를 찾지 못했어요');
    allow(ws, b.mode);
    const run = await createWorkflowRun(ctx, ws, doc, { mode: b.mode, sampleItems: b.sampleItems });
    await idem.remember(run.runId);
    res.status(202).json({ runId: run.runId, eventsUrl: `/api/workflow-runs/${run.runId}/events` });
    launch(ws, run.runId);
  });

  router.get('/api/workflow-runs/:id/events', async (req, res) => {
    const ws = wsOf(req);
    const id = String(req.params.id);
    await load(ws, id);
    await hub.serve(req, res, ws, id, {
      terminalNames: WF_TERMINAL_EVENTS,
      alreadyFinished: async () => { const s = (await getWfRun(ctx, ws, id))?.status; return s !== 'running' && s !== 'queued'; },
    });
  });

  router.get('/api/workflow-runs/:id', async (req, res) => {
    res.json(view(await load(wsOf(req), String(req.params.id))));
  });

  router.post('/api/workflow-runs/:id/review', json, async (req, res) => {
    const ws = wsOf(req);
    const run = await load(ws, String(req.params.id));
    const nodeId = req.body?.nodeId;
    const raw = req.body?.decisions;
    if (typeof nodeId !== 'string' || !Array.isArray(raw)) invalid('nodeId와 decisions 배열이 필요해요');
    const node = run.nodes[nodeId];
    if (run.status !== 'waiting_review' || node?.status !== 'waiting_review') throw new ApiError(409, 'not_waiting', '검토를 기다리는 단계가 아니에요');
    if (isWorkflowRunActive(run.runId)) throw new ApiError(409, 'run_busy', '실행이 아직 정리되는 중이에요. 잠시 뒤 다시 시도해 주세요');
    const known = new Set((node.waitingItems ?? []).map((r) => String(r.itemId)));
    const approve = new Map<string, boolean>();
    for (const d of raw) {
      if (!d || typeof d.itemId !== 'string' || typeof d.approve !== 'boolean') invalid('decisions 항목은 {itemId, approve:boolean} 형식이어야 해요');
      if (!known.has(d.itemId)) invalid(`검토 대상이 아닌 항목이에요: ${d.itemId}`);
      approve.set(d.itemId, d.approve);
    }
    const decisions = [...known].map((itemId) => ({ itemId, approve: approve.get(itemId) === true }));
    const saved = await saveWfRun(ctx, { ...run, status: 'queued', reviews: { ...run.reviews, [nodeId]: decisions } });
    res.status(202).json({ runId: saved.runId, status: saved.status });
    launch(ws, saved.runId);
  });

  router.post('/api/workflow-runs/:id/rerun', json, async (req, res) => {
    const ws = wsOf(req);
    const prev = await load(ws, String(req.params.id));
    const from = req.body?.fromNodeId;
    if (typeof from !== 'string' || !from) invalid('fromNodeId 값이 필요해요');
    allow(ws, prev.mode);
    const run = await createRerun(ctx, ws, prev, from);
    res.status(202).json({ runId: run.runId, rerunOf: prev.runId, eventsUrl: `/api/workflow-runs/${run.runId}/events` });
    launch(ws, run.runId);
  });

  router.post('/api/workflow-runs/:id/cancel', async (req, res) => {
    const ws = wsOf(req);
    const run = await load(ws, String(req.params.id));
    if (run.status !== 'running' && run.status !== 'queued' && run.status !== 'waiting_review') { res.json({ status: run.status }); return; }
    if (cancelWorkflowRun(run.runId)) { res.status(202).json({ status: 'cancelling' }); return; }
    await saveWfRun(ctx, { ...run, status: 'cancelled', failureCode: 'cancelled' });
    await hub.emit(ws, run.runId, 'workflow.failed', { code: 'cancelled', status: 'cancelled', retryable: false });
    res.status(202).json({ status: 'cancelled' });
  });
}
