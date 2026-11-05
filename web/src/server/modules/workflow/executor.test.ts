import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../context.js';
import { MemoryBlobStore, MemoryDocStore } from '../../stores/memory.js';
import { setCollector } from '../runs/collectorAdapter.js';
import { canonicalHash, jobsToResumeTemplate, topologicalOrder, validateDefinition } from './contract.js';
import { createRerun, executeWorkflowRun, runWorkflow } from './executor.js';
import { getWfRun, saveWfRun } from './nodeRuns.js';
import type { WorkflowDoc } from './store.js';

const WS = 'ws1';
const sse = (res: http.ServerResponse, events: [string, object][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  events.forEach(([e, d], i) => res.write(`id: x:${i + 1}\nevent: ${e}\ndata: ${JSON.stringify({ runId: 'x', seq: i + 1, ...d })}\n\n`));
  res.end();
};

describe('workflow executor (fake collector + fake evaluator)', () => {
  const store = new MemoryDocStore();
  const blobs = new MemoryBlobStore();
  let evaluator: http.Server;
  let ctx: AppContext;
  let evalCalls = 0;

  const def = { ...jobsToResumeTemplate({ id: 'wf1', contractId: 'c1', resumeId: 'r1', criteriaSetId: 'cs1' }), revision: 1 };
  const doc = (over: Partial<WorkflowDoc> = {}): WorkflowDoc => ({
    id: 'workflow:wf1:v1', type: 'workflow', workspaceId: WS, workflowId: 'wf1', revision: 1, status: 'validated', definition: def,
    validation: validateDefinition(def), origin: 'template', createdAt: 'x', updatedAt: 'x', ...over,
  });
  const approved = () => doc({
    status: 'approved',
    approval: { definitionHash: canonicalHash(def), approvedAt: 'x', budget: def.limits, scope: { nodeIds: [], kinds: [], externalSubmit: false, humanReviewRequired: true } },
  });

  beforeAll(async () => {
    evaluator = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        evalCalls++;
        sse(res, [
          ['verdict.final', { itemKey: 'a1', decision: 'pass', holdReasons: [], criteria: [] }],
          ['verdict.final', { itemKey: 'b2', decision: 'hold', holdReasons: ['detail_missing'], criteria: [] }],
          ['verdict.final', { itemKey: 'c3', decision: 'reject', holdReasons: [], criteria: [] }],
          ['run.completed', {}],
        ]);
      });
    });
    await new Promise<void>((r) => evaluator.listen(0, '127.0.0.1', r));
    ctx = {
      config: { evaluatorUrl: `http://127.0.0.1:${(evaluator.address() as AddressInfo).port}`, limits: { maxItems: 20, maxDetails: 10, runSeconds: 60, modelCalls: 40 } },
      store, blobs, assertRunAllowed: () => undefined, assertBrowserSessionAllowed: () => undefined, releaseBrowserSession: () => undefined,
    } as unknown as AppContext;
    await store.upsert(approved());
    await store.upsert({ id: 'contract:c1:v1', type: 'contract', workspaceId: WS, version: 1 });
    await store.upsert({ id: 'criteria:cs1:v1', type: 'criteriaSet', workspaceId: WS, criteriaSetId: 'cs1', version: 1, ruleCards: [], semanticCards: [{ id: 's1', text: 'Node.js', required: true }] });
    await store.upsert({ id: 'resume:r1', type: 'resume', workspaceId: WS, resumeId: 'r1', facts: [{ id: 'F1', text: 'Node.js 백엔드 개발', confirmed: true }] });
    setCollector(async (c, ws, _contract, opts) => {
      for (const k of ['a1', 'b2', 'c3', 'd4', 'e5']) {
        await c.store.upsert({
          id: `item:${opts.collectionRunId}:${k}`, type: 'item', workspaceId: ws, itemKey: k,
          fields: { company: `${k}사`, title: '백엔드 Node.js', detailUrl: `https://x/${k}` }, detailStatus: 'detail_missing', injectionSuspected: false,
        });
      }
      return { status: 'completed', contractId: 'c1', contractVersion: 1, items: [], skippedItems: 0, total: 5 };
    });
  });
  afterAll(() => { setCollector(undefined); evaluator.close(); });

  it('orders the template topologically', () => {
    const { order, cyclic } = topologicalOrder(def);
    expect(cyclic).toEqual([]);
    expect(order.indexOf('collect')).toBeLessThan(order.indexOf('evaluate'));
    expect(order.indexOf('review')).toBeLessThan(order.indexOf('tailor'));
  });

  it('rejects a full run that is not approved', async () => {
    await expect(runWorkflow(ctx, WS, doc(), { mode: 'full' })).rejects.toMatchObject({ status: 409, code: 'not_approved' });
    const tampered = approved();
    tampered.definition = { ...def, name: '바뀜' };
    await expect(runWorkflow(ctx, WS, tampered, { mode: 'full' })).rejects.toMatchObject({ code: 'not_approved' });
  });

  it('caps sample runs and marks the output as sample', async () => {
    const run = await runWorkflow(ctx, WS, doc(), { mode: 'sample', sampleItems: 2 });
    expect(run.status).toBe('completed');
    expect(run.nodes.collect.outputCount).toBe(2);
    expect(run.nodes.review.status).toBe('completed');
    expect(run.artifacts.exportDocs.sample).toBe(true);
    expect(run.modelCalls).toBeLessThanOrEqual(10);
  });

  it('pauses at humanReview, resumes with decisions, then reruns from a node', async () => {
    const waiting = await runWorkflow(ctx, WS, approved(), { mode: 'full' });
    expect(waiting.status).toBe('waiting_review');
    expect(waiting.nodes.review.waitingItems?.map((r) => r.itemId)).toEqual(['a1']);
    expect(waiting.nodes.exportList.status).toBe('completed');
    expect(waiting.nodes.tailor.status).toBe('pending');

    await saveWfRun(ctx, { ...waiting, status: 'queued', reviews: { review: [{ itemId: 'a1', approve: true }] } });
    const done = await executeWorkflowRun(ctx, WS, waiting.runId);
    expect(done?.status).toBe('completed');
    expect(done?.artifacts.exportDocs.markdown).toContain('Node.js 백엔드 개발');

    const callsBefore = evalCalls;
    const rerun = await createRerun(ctx, WS, (await getWfRun(ctx, WS, waiting.runId))!, 'tailor');
    expect(rerun.nodes.evaluate.status).toBe('completed');
    expect(rerun.nodes.tailor.status).toBe('pending');
    const finished = await executeWorkflowRun(ctx, WS, rerun.runId);
    expect(finished?.status).toBe('completed');
    expect(finished?.nodes.tailor.attempt).toBe(2);
    expect(evalCalls).toBe(callsBefore);
  });
});
