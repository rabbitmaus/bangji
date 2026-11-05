// 서버 modules/workflow/schema.ts 의 UI용 사본 (zod 의존 없음). 서버 타입과 동일하게 유지할 것.
export type PortType = 'items' | 'verdictItems' | 'artifact';
export type NodeKind = 'collect' | 'mergeDedupe' | 'normalizeFields' | 'ruleFilter' | 'evidenceEvaluate' | 'branch' | 'humanReview' | 'tailor' | 'exportMarkdown' | 'exportList';
export type EdgeCondition = 'pass' | 'reject' | 'hold' | 'else' | 'true' | 'false';
export type WorkflowStatus = 'draft' | 'validated' | 'approved';

export interface NodeDef { id: string; kind: string; label?: string; config: Record<string, unknown>; retry?: { max: number }; timeoutSeconds?: number }
export interface EdgeDef { id: string; from: { node: string; port: string }; to: { node: string; port: string }; when?: EdgeCondition }
export interface WorkflowLimits { maxItems: number; maxDetails: number; maxModelCalls: number; runSeconds: number; maxFanout: number }
export interface ApprovalPolicy { requireApprovalBeforeRun: boolean; requireHumanReviewForArtifacts: boolean; forbidExternalSubmit: boolean }
export interface WorkflowDefinition {
  schemaVersion: 1; id: string; name: string; description?: string; revision: number; goal?: string;
  nodes: NodeDef[]; edges: EdgeDef[]; limits: WorkflowLimits; approvalPolicy: ApprovalPolicy;
  layout?: Record<string, { x: number; y: number }>;
}
export interface ValidationIssue { code: string; nodeId?: string; edgeId?: string; message: string }
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }
export interface WorkflowApproval {
  definitionHash: string; approvedAt: string; budget: WorkflowLimits;
  scope: { nodeIds: string[]; kinds: string[]; externalSubmit: false; humanReviewRequired: boolean };
}
export interface PortSpec { name: string; type: PortType; required?: boolean; multi?: boolean; label: string }
export interface NodeCatalogEntry {
  kind: NodeKind; label: string; description: string; supported: boolean; inputs: PortSpec[]; outputs: PortSpec[];
  defaultConfig: Record<string, unknown>; needsResumeFacts: boolean; isOutput: boolean; isSource: boolean;
}
export interface DefinitionChange { target: 'node' | 'edge' | 'limits' | 'policy' | 'meta'; op: 'added' | 'removed' | 'changed'; id?: string; keys?: string[]; summary: string }
export interface WorkflowView {
  workflowId: string; revision: number; status: WorkflowStatus; definition: WorkflowDefinition; validation: ValidationResult;
  approval?: WorkflowApproval; origin: 'template' | 'manual' | 'assistant'; createdAt: string; updatedAt: string; etag?: string;
}
export interface WorkflowSummary { workflowId: string; revision: number; status: WorkflowStatus; name: string; nodeCount: number; errorCount: number; updatedAt: string }

export const WORKFLOW_LIMIT_MAX: WorkflowLimits = { maxItems: 50, maxDetails: 20, maxModelCalls: 120, runSeconds: 300, maxFanout: 5 };
