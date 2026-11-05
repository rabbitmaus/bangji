import express from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, type RegisterModule } from '../../context.js';
import { registerWorkflowRunRoutes } from './runRoutes.js';
import { getNodeCatalogView } from './catalog.js';
import {
  approveBodySchema, createWorkflowBodySchema, diffBodySchema, saveWorkflowBodySchema,
  type WorkflowApproval, type WorkflowDefinition,
} from './schema.js';
import { getWorkflowDoc, listWorkflowDocs, saveWorkflowDoc, workflowDocId, type WorkflowDoc } from './store.js';
import { emptyTemplate, jobsListOnlyTemplate, jobsToResumeTemplate, twoSourceMergeTemplate } from './templates.js';
import { canonicalHash, diffDefinitions, validateDefinition } from './validate.js';
import { mountAssistantRoutes } from './assistantRoutes.js';

const view = (d: WorkflowDoc) => ({
  workflowId: d.workflowId, revision: d.revision, status: d.status, definition: d.definition,
  validation: d.validation, approval: d.approval, origin: d.origin, createdAt: d.createdAt, updatedAt: d.updatedAt, etag: d._etag,
});
const summary = (d: WorkflowDoc) => ({
  workflowId: d.workflowId, revision: d.revision, status: d.status, name: d.definition.name,
  nodeCount: d.definition.nodes.length, errorCount: d.validation.errors.length, updatedAt: d.updatedAt,
});

const mod: RegisterModule = (router, ctx) => {
  registerWorkflowRunRoutes(router, ctx);
  const json = express.json({ limit: '256kb' });
  const ws = (req: express.Request) => {
    if (!req.workspaceId) throw new ApiError(401, 'unauthorized', '작업 공간을 확인할 수 없어요');
    return req.workspaceId;
  };
  const latestOr404 = async (workspaceId: string, id: string) => {
    const d = await getWorkflowDoc(ctx.store, workspaceId, id);
    if (!d) throw new ApiError(404, 'not_found', '워크플로를 찾지 못했어요');
    return d;
  };

  router.get('/api/workflows/node-catalog', (_req, res) => { res.json({ nodes: getNodeCatalogView() }); });

  router.post('/api/workflows', json, async (req, res) => {
    const workspaceId = ws(req);
    const parsed = createWorkflowBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '워크플로 생성 요청 형식이 올바르지 않아요');
    const id = randomUUID().slice(0, 8);
    const p = { id, name: parsed.data.name, goal: parsed.data.goal };
    const t = parsed.data.template;
    const base = t === 'jobsToResume' ? jobsToResumeTemplate(p) : t === 'jobsListOnly' ? jobsListOnlyTemplate(p)
      : t === 'twoSourceMerge' ? twoSourceMergeTemplate(p) : emptyTemplate(p);
    const definition: WorkflowDefinition = { ...base, revision: 1 };
    const now = new Date().toISOString();
    const doc = await saveWorkflowDoc(ctx.store, {
      id: workflowDocId(id, 1), type: 'workflow', workspaceId, workflowId: id, revision: 1, status: 'draft',
      definition, validation: validateDefinition(definition), origin: 'template', createdAt: now, updatedAt: now,
    });
    res.status(201).json(view(doc));
  });

  router.get('/api/workflows', async (req, res) => {
    const docs = await listWorkflowDocs(ctx.store, ws(req));
    const latest = new Map<string, WorkflowDoc>();
    for (const d of docs) { const c = latest.get(d.workflowId); if (!c || d.revision > c.revision) latest.set(d.workflowId, d); }
    res.json({ workflows: [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) });
  });

  router.get('/api/workflows/:id/versions', async (req, res) => {
    const docs = await listWorkflowDocs(ctx.store, ws(req), String(req.params.id));
    if (!docs.length) throw new ApiError(404, 'not_found', '워크플로를 찾지 못했어요');
    res.json({ versions: docs.sort((a, b) => b.revision - a.revision).map(summary) });
  });

  router.get('/api/workflows/:id', async (req, res) => {
    const rev = req.query.revision ? Number(req.query.revision) : undefined;
    const d = await getWorkflowDoc(ctx.store, ws(req), String(req.params.id), rev);
    if (!d) throw new ApiError(404, 'not_found', '워크플로를 찾지 못했어요');
    res.json(view(d));
  });

  router.put('/api/workflows/:id', json, async (req, res) => {
    const workspaceId = ws(req);
    const id = String(req.params.id);
    const parsed = saveWorkflowBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '워크플로 정의 형식이 올바르지 않아요');
    const latest = await latestOr404(workspaceId, id);
    if (parsed.data.baseRevision !== latest.revision) {
      throw new ApiError(409, 'revision_conflict', `다른 곳에서 먼저 수정됐어요 (최신 revision ${latest.revision}). 새로 불러와 다시 적용해 주세요`);
    }
    const revision = latest.revision + 1;
    const definition: WorkflowDefinition = { ...parsed.data.definition, id, revision };
    const now = new Date().toISOString();
    const doc = await saveWorkflowDoc(ctx.store, {
      id: workflowDocId(id, revision), type: 'workflow', workspaceId, workflowId: id, revision, status: 'draft',
      definition, validation: validateDefinition(definition), origin: 'manual', createdAt: now, updatedAt: now,
    });
    res.json(view(doc));
  });

  router.post('/api/workflows/:id/validate', json, async (req, res) => {
    const workspaceId = ws(req);
    const d = await latestOr404(workspaceId, String(req.params.id));
    const validation = validateDefinition(d.definition);
    const status = d.status === 'approved' ? (validation.ok ? 'approved' : 'draft') : validation.ok ? 'validated' : 'draft';
    const saved = await saveWorkflowDoc(ctx.store, { ...d, validation, status, approval: status === 'approved' ? d.approval : undefined });
    res.json(view(saved));
  });

  router.post('/api/workflows/:id/approve', json, async (req, res) => {
    const workspaceId = ws(req);
    const parsed = approveBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '승인할 revision이 필요해요');
    const d = await latestOr404(workspaceId, String(req.params.id));
    if (parsed.data.revision !== d.revision) throw new ApiError(409, 'revision_conflict', `최신 revision(${d.revision})만 승인할 수 있어요`);
    const validation = validateDefinition(d.definition);
    if (!validation.ok) throw new ApiError(422, 'validation_failed', '검증 오류를 먼저 해결해야 승인할 수 있어요');
    const def = d.definition;
    const approval: WorkflowApproval = {
      definitionHash: canonicalHash(def), approvedAt: new Date().toISOString(), budget: def.limits,
      scope: { nodeIds: def.nodes.map((n) => n.id), kinds: [...new Set(def.nodes.map((n) => n.kind))], externalSubmit: false, humanReviewRequired: true },
    };
    const saved = await saveWorkflowDoc(ctx.store, { ...d, validation, status: 'approved', approval });
    res.json(view(saved));
  });

  router.post('/api/workflows/:id/diff', json, async (req, res) => {
    const workspaceId = ws(req);
    const id = String(req.params.id);
    const parsed = diffBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '비교할 revision 두 개가 필요해요');
    const [a, b] = await Promise.all([getWorkflowDoc(ctx.store, workspaceId, id, parsed.data.revA), getWorkflowDoc(ctx.store, workspaceId, id, parsed.data.revB)]);
    if (!a || !b) throw new ApiError(404, 'not_found', '해당 revision을 찾지 못했어요');
    const changes = diffDefinitions(a.definition, b.definition);
    res.json({ revA: a.revision, revB: b.revision, changes, summary: changes.map((c) => c.summary) });
  });

  mountAssistantRoutes(router, ctx);
};

export default mod;
