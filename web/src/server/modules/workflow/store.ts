import type { Doc, DocStore } from '../../context.js';
import type { ValidationResult, WorkflowApproval, WorkflowDefinition, WorkflowStatus } from './schema.js';

export const WORKFLOW_TTL = 604800;

export interface WorkflowDoc extends Doc {
  type: 'workflow';
  workflowId: string;
  revision: number;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  validation: ValidationResult;
  approval?: WorkflowApproval;
  origin: 'template' | 'manual' | 'assistant';
  createdAt: string;
  updatedAt: string;
}

export const workflowDocId = (workflowId: string, revision: number) => `workflow:${workflowId}:v${revision}`;

export async function listWorkflowDocs(store: DocStore, workspaceId: string, workflowId?: string): Promise<WorkflowDoc[]> {
  return store.list<WorkflowDoc>(workspaceId, 'workflow', workflowId ? `workflow:${workflowId}:v` : 'workflow:');
}

// revision 생략 시 최신 revision
export async function getWorkflowDoc(store: DocStore, workspaceId: string, workflowId: string, revision?: number): Promise<WorkflowDoc | undefined> {
  if (revision != null) return store.get<WorkflowDoc>(workspaceId, workflowDocId(workflowId, revision));
  const docs = await listWorkflowDocs(store, workspaceId, workflowId);
  return docs.reduce<WorkflowDoc | undefined>((a, b) => (!a || b.revision > a.revision ? b : a), undefined);
}

export async function saveWorkflowDoc(store: DocStore, doc: WorkflowDoc): Promise<WorkflowDoc> {
  return store.upsert<WorkflowDoc>({ ...doc, ttl: WORKFLOW_TTL, updatedAt: new Date().toISOString() });
}
