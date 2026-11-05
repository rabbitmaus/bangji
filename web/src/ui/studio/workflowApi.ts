import { postSse, type SseMessage } from '../sse';
import type {
  DefinitionChange, NodeCatalogEntry, PortType, ValidationIssue, ValidationResult,
  WorkflowDefinition, WorkflowSummary, WorkflowView,
} from './workflowTypes';

export class WfError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function wfErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : '알 수 없는 오류가 발생했어요.';
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    throw new WfError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `요청에 실패했어요 (${res.status})`);
  }
  return json as T;
}

export type TemplateName = 'jobsToResume' | 'jobsListOnly' | 'twoSourceMerge' | 'reviewFirstList' | 'twoSourceResume' | 'priceMonitor' | 'hackathonMonitor' | 'empty';

export interface NodeRunState {
  status: string;
  inputCount: number;
  outputCount: number;
  preview: unknown[];
  error?: string | { code?: string; message?: string };
  modelCalls: number;
}
export interface RunDoc {
  runId?: string;
  status: string;
  nodes: Record<string, NodeRunState>;
  summary?: string;
  artifacts?: unknown[] | Record<string, unknown>;
}
export interface ReviewDecision { itemId: string; approve: boolean }

export interface AssistProposal {
  proposalId: string;
  baseRevision: number;
  ops: unknown[];
  summaryKo: string[];
  diff: DefinitionChange[];
  validation: ValidationResult;
  warnings: ValidationIssue[] | string[];
  rationale?: string;
  aiGenerated: boolean;
}

export const wf = {
  catalog: () => req<{ nodes: NodeCatalogEntry[] }>('GET', '/api/workflows/node-catalog').then((r) => r.nodes),
  list: () => req<{ workflows: WorkflowSummary[] }>('GET', '/api/workflows').then((r) => r.workflows),
  create: (template: TemplateName, name: string) => req<WorkflowView>('POST', '/api/workflows', { template, name }),
  get: (id: string) => req<WorkflowView>('GET', `/api/workflows/${encodeURIComponent(id)}`),
  save: (id: string, baseRevision: number, definition: WorkflowDefinition) =>
    req<WorkflowView>('PUT', `/api/workflows/${encodeURIComponent(id)}`, { baseRevision, definition }),
  validate: (id: string) => req<WorkflowView>('POST', `/api/workflows/${encodeURIComponent(id)}/validate`, {}),
  approve: (id: string, revision: number) => req<WorkflowView>('POST', `/api/workflows/${encodeURIComponent(id)}/approve`, { revision }),
  versions: (id: string) => req<{ versions: WorkflowSummary[] }>('GET', `/api/workflows/${encodeURIComponent(id)}/versions`).then((r) => r.versions),
  diff: (id: string, revA: number, revB: number) =>
    req<{ revA: number; revB: number; changes: DefinitionChange[]; summary: string[] }>('POST', `/api/workflows/${encodeURIComponent(id)}/diff`, { revA, revB }),

  startRun: (workflowId: string, mode: 'sample' | 'full', revision?: number, sampleItems?: number) =>
    req<{ runId: string }>('POST', '/api/workflow-runs', { workflowId, revision, mode, sampleItems }),
  getRun: (runId: string) => req<RunDoc>('GET', `/api/workflow-runs/${encodeURIComponent(runId)}`),
  review: (runId: string, nodeId: string, decisions: ReviewDecision[]) =>
    req<unknown>('POST', `/api/workflow-runs/${encodeURIComponent(runId)}/review`, { nodeId, decisions }),
  rerun: (runId: string, fromNodeId: string) =>
    req<unknown>('POST', `/api/workflow-runs/${encodeURIComponent(runId)}/rerun`, { fromNodeId }),
  cancel: (runId: string) => req<unknown>('POST', `/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, {}),
  runEventsUrl: (runId: string) => `/api/workflow-runs/${encodeURIComponent(runId)}/events`,

  assist: (id: string, message: string, baseRevision: number, onMessage: (m: SseMessage) => void, signal?: AbortSignal) =>
    postSse(`/api/workflows/${encodeURIComponent(id)}/assist`, { message, baseRevision }, onMessage, signal),
  applyProposal: (id: string, pid: string, baseRevision: number) =>
    req<unknown>('POST', `/api/workflows/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/apply`, { baseRevision }),
  rejectProposal: (id: string, pid: string) =>
    req<unknown>('POST', `/api/workflows/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/reject`, {}),
};

// 서버 catalog.ts 의 portsCompatible 과 동일
export function portsCompatible(from: PortType, to: PortType): boolean {
  return from === to || (from === 'verdictItems' && to === 'items');
}

/** 위상 정렬(동순위는 배열 순서). 순환 노드는 뒤에 붙인다. */
export function topoOrder(def: WorkflowDefinition): string[] {
  const ids = def.nodes.map((n) => n.id);
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const e of def.edges) {
    if (indeg.has(e.from.node) && indeg.has(e.to.node)) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  }
  const out: string[] = [];
  const done = new Set<string>();
  for (;;) {
    const next = ids.find((i) => !done.has(i) && (indeg.get(i) ?? 0) === 0);
    if (!next) break;
    done.add(next);
    out.push(next);
    for (const e of def.edges) {
      if (e.from.node === next && indeg.has(e.to.node)) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) - 1);
    }
  }
  for (const i of ids) if (!done.has(i)) out.push(i);
  return out;
}

export function uniqueId(prefix: string, taken: string[]): string {
  let n = 1;
  while (taken.includes(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}
