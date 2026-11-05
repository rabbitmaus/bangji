import { randomUUID } from 'node:crypto';
import type { AppContext, Doc } from '../../context.js';
import type { NodeOutputs, WfArtifact } from './executorNodes.js';

export const WFRUN_TTL = 604800;

export type WfRunStatus = 'queued' | 'running' | 'waiting_review' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type WfNodeStatus = 'pending' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface WfNodeState {
  status: WfNodeStatus;
  startedAt?: string;
  finishedAt?: string;
  inputCount: number;
  outputCount: number;
  outputs?: Record<string, number>;
  preview: Record<string, unknown>[];
  error?: { code: string; message: string };
  modelCalls: number;
  attempt: number;
  waitingItems?: Record<string, unknown>[];
}

export interface WfRunDoc extends Doc {
  type: 'wfrun';
  runId: string;
  workflowId: string;
  revision: number;
  definitionHash: string;
  status: WfRunStatus;
  mode: 'sample' | 'full';
  sampleItems?: number;
  nodes: Record<string, WfNodeState>;
  snapshot: { criteriaSetId?: string; criteriaVersion?: number; criteriaHash?: string; resumeId?: string; resumeVersion?: string; resumeHash?: string };
  limits: { maxItems: number; maxDetails: number; maxModelCalls: number; runSeconds: number };
  modelCalls: number;
  reviews: Record<string, { itemId: string; approve: boolean }[]>;
  artifacts: Record<string, WfArtifact>;
  failureCode?: string;
  rerunOf?: string;
  fromNodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export const newWfRunId = () => `wfrun_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const wfRunDocId = (runId: string) => `wfrun:${runId}`;
const blobPath = (ws: string, runId: string, nodeId: string) => `workflow-runs/${ws}/${runId}/${nodeId}.json`;

export const getWfRun = (ctx: AppContext, ws: string, runId: string) => ctx.store.get<WfRunDoc>(ws, wfRunDocId(runId));

export async function saveWfRun(ctx: AppContext, run: WfRunDoc): Promise<WfRunDoc> {
  return ctx.store.upsert<WfRunDoc>({ ...run, ttl: WFRUN_TTL, updatedAt: new Date().toISOString() });
}

export async function saveNodeOutput(ctx: AppContext, ws: string, runId: string, nodeId: string, out: NodeOutputs): Promise<void> {
  await ctx.blobs.put(blobPath(ws, runId, nodeId), JSON.stringify(out), 'application/json');
}

export async function loadNodeOutput(ctx: AppContext, ws: string, runId: string, nodeId: string): Promise<NodeOutputs | undefined> {
  const b = await ctx.blobs.get(blobPath(ws, runId, nodeId));
  return b ? (JSON.parse(b.data.toString('utf8')) as NodeOutputs) : undefined;
}

export async function copyNodeOutput(ctx: AppContext, ws: string, fromRun: string, toRun: string, nodeId: string): Promise<boolean> {
  const out = await loadNodeOutput(ctx, ws, fromRun, nodeId);
  if (!out) return false;
  await saveNodeOutput(ctx, ws, toRun, nodeId, out);
  return true;
}

export const emptyNode = (): WfNodeState => ({ status: 'pending', inputCount: 0, outputCount: 0, preview: [], modelCalls: 0, attempt: 0 });

// 재시작 등으로 실행기가 사라진 running/queued 실행을 interrupted 실패로 표시한다.
export async function markOrphaned(ctx: AppContext, run: WfRunDoc, isActive: (runId: string) => boolean): Promise<WfRunDoc> {
  if ((run.status !== 'running' && run.status !== 'queued') || isActive(run.runId)) return run;
  const now = new Date().toISOString();
  const nodes = Object.fromEntries(Object.entries(run.nodes).map(([id, n]) => [
    id, n.status === 'running' ? { ...n, status: 'failed' as const, finishedAt: now, error: { code: 'interrupted', message: '서버가 다시 시작되어 중단됐어요' } } : n,
  ]));
  return saveWfRun(ctx, { ...run, nodes, status: 'failed', failureCode: 'interrupted' });
}
