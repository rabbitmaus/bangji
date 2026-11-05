import { z } from 'zod';

export const PORT_TYPES = ['items', 'verdictItems', 'artifact'] as const;
export type PortType = (typeof PORT_TYPES)[number];

export const NODE_KINDS = [
  'collect', 'mergeDedupe', 'normalizeFields', 'ruleFilter', 'evidenceEvaluate',
  'branch', 'humanReview', 'tailor', 'exportMarkdown', 'exportList',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const FORBIDDEN_KINDS: Record<string, string> = {
  code: '임의 코드 실행 노드는 허용되지 않아요',
  script: '스크립트 실행 노드는 허용되지 않아요',
  externalSubmit: '외부 사이트 제출(지원) 노드는 허용되지 않아요. 제출은 항상 직접 해야 해요',
  loop: '반복(루프) 노드는 지원하지 않아요. 흐름은 순환 없는 그래프여야 해요',
};

export const EDGE_CONDITIONS = ['pass', 'reject', 'hold', 'else', 'true', 'false'] as const;
export type EdgeCondition = (typeof EDGE_CONDITIONS)[number];

export const WORKFLOW_LIMIT_MAX = { maxItems: 50, maxDetails: 20, maxModelCalls: 120, runSeconds: 300, maxFanout: 5 } as const;

export const nodeDefSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/, '노드 ID는 영문·숫자·_- 1~40자여야 해요'),
  kind: z.string().min(1).max(40),
  label: z.string().max(80).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  retry: z.object({ max: z.number().int().min(0).max(2) }).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
});

const endpointSchema = z.object({ node: z.string().min(1).max(40), port: z.string().min(1).max(40) });

export const edgeDefSchema = z.object({
  id: z.string().regex(/^[\w-]{1,60}$/, '연결 ID는 영문·숫자·_- 1~60자여야 해요'),
  from: endpointSchema,
  to: endpointSchema,
  when: z.enum(EDGE_CONDITIONS).optional(),
});

export const limitsSchema = z.object({
  maxItems: z.number().int().min(1),
  maxDetails: z.number().int().min(0),
  maxModelCalls: z.number().int().min(0),
  runSeconds: z.number().int().min(1),
  maxFanout: z.number().int().min(1),
});

export const approvalPolicySchema = z.object({
  requireApprovalBeforeRun: z.boolean(),
  requireHumanReviewForArtifacts: z.boolean(),
  forbidExternalSubmit: z.boolean(),
});

export const workflowDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[\w-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  revision: z.number().int().min(0),
  goal: z.string().max(2000).optional(),
  nodes: z.array(nodeDefSchema).max(40),
  edges: z.array(edgeDefSchema).max(100),
  limits: limitsSchema,
  approvalPolicy: approvalPolicySchema,
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});

export type NodeDef = z.infer<typeof nodeDefSchema>;
export type EdgeDef = z.infer<typeof edgeDefSchema>;
export type WorkflowLimits = z.infer<typeof limitsSchema>;
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export type WorkflowStatus = 'draft' | 'validated' | 'approved';

export interface ValidationIssue { code: string; nodeId?: string; edgeId?: string; message: string }
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

export interface WorkflowApproval {
  definitionHash: string;
  approvedAt: string;
  budget: WorkflowLimits;
  scope: { nodeIds: string[]; kinds: string[]; externalSubmit: false; humanReviewRequired: boolean };
}

export interface DefinitionChange {
  target: 'node' | 'edge' | 'limits' | 'policy' | 'meta';
  op: 'added' | 'removed' | 'changed';
  id?: string;
  keys?: string[];
  summary: string;
}

export const saveWorkflowBodySchema = z.object({ baseRevision: z.number().int().min(0), definition: workflowDefinitionSchema });
export const createWorkflowBodySchema = z.object({
  template: z.enum(['jobsToResume', 'jobsListOnly', 'twoSourceMerge', 'reviewFirstList', 'twoSourceResume', 'priceMonitor', 'hackathonMonitor', 'empty']).default('empty'),
  name: z.string().trim().min(1).max(80).optional(),
  goal: z.string().max(2000).optional(),
});
export const approveBodySchema = z.object({ revision: z.number().int().min(1) });
export const diffBodySchema = z.object({ revA: z.number().int().min(1), revB: z.number().int().min(1) });
