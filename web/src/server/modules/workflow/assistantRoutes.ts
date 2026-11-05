import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Doc, type RegisterModule } from '../../context.js';
import { createWorkspaceSession } from '../copilot/client.js';
import { fakeModelEnabled } from '../copilot/fake.js';
import { startSse, writeSse } from '../copilot/sse.js';
import { MAX_REPAIR_ROUNDS, buildProposalBody, buildSystemPrompt, applyOps, fakePlan, isStaleBase, patchOpsSchema, wrapUntrusted, type PatchOp, type ProposalBody } from './assistantPlan.js';
import { buildAssistTools, type AssistToolState } from './assistantTools.js';
import { getNodeCatalogView, validateDefinition, type WorkflowDefinition } from './contract.js';
import { getWorkflowDoc, saveWorkflowDoc, workflowDocId, type WorkflowDoc } from './store.js';

const PROPOSAL_TTL = 604800;
const proposalDocId = (workflowId: string, pid: string) => `wfproposal:${workflowId}:${pid}`;

export interface WorkflowProposalDoc extends Doc, ProposalBody {
  type: 'wfproposal';
  proposalId: string;
  workflowId: string;
  baseRevision: number;
  status: 'pending' | 'applied' | 'rejected';
  message: string;
  createdAt: string;
  updatedAt: string;
}

const assistBody = z.object({ message: z.string().trim().min(1).max(2000), baseRevision: z.number().int().min(0) });
const revBody = z.object({ baseRevision: z.number().int().min(0) });

const view = (d: WorkflowDoc) => ({
  workflowId: d.workflowId, revision: d.revision, status: d.status, definition: d.definition,
  validation: d.validation, approval: d.approval, origin: d.origin, createdAt: d.createdAt, updatedAt: d.updatedAt, etag: d._etag,
});

export const staleMessage = (latest: number) => `다른 곳에서 먼저 수정됐어요 (최신 revision ${latest}). 변경안을 다시 요청해 주세요`;

export function mountAssistantRoutes(router: express.Router, ctx: Parameters<RegisterModule>[1]): void {
  const json = express.json({ limit: '16kb' });
  const ws = (req: express.Request) => {
    if (!req.workspaceId) throw new ApiError(401, 'unauthorized', '작업 공간을 확인할 수 없어요');
    return req.workspaceId;
  };
  const loadProposal = async (workspaceId: string, wid: string, pid: string) => {
    const p = await ctx.store.get<WorkflowProposalDoc>(workspaceId, proposalDocId(wid, pid));
    if (!p) throw new ApiError(404, 'not_found', '변경안을 찾지 못했어요');
    return p;
  };

  router.post('/api/workflows/:id/assist', json, async (req, res) => {
    const workspaceId = ws(req);
    const wid = String(req.params.id);
    const body = assistBody.safeParse(req.body);
    if (!body.success) throw new ApiError(400, 'validation_failed', '요청을 1~2000자로 입력하고 baseRevision을 함께 보내 주세요');
    const latest = await getWorkflowDoc(ctx.store, workspaceId, wid);
    if (!latest) throw new ApiError(404, 'not_found', '워크플로를 찾지 못했어요');
    if (isStaleBase(body.data.baseRevision, latest.revision)) throw new ApiError(409, 'revision_conflict', staleMessage(latest.revision));
    (ctx.assertAssistantAllowed ?? ctx.assertRunAllowed)(workspaceId);

    startSse(res);
    const emit = (event: string, data: unknown) => writeSse(res, event, data);
    emit('assist.started', { workflowId: wid, baseRevision: latest.revision });
    const base = latest.definition;
    const state: AssistToolState = { repairRounds: 0 };
    let session: Awaited<ReturnType<typeof createWorkspaceSession>> | undefined;
    try {
      let proposalBody: ProposalBody | undefined;
      let failure: string | undefined;
      if (fakeModelEnabled()) {
        const plan = fakePlan(base, body.data.message);
        emit('assist.tool', { name: 'propose_patch', summary: '예시 변경안 생성(가짜 모델)' });
        const r = buildProposalBody(base, plan.ops, plan.rationale);
        if ('errors' in r) failure = 'no_valid_proposal'; else proposalBody = r;
      } else {
        session = await createWorkspaceSession({
          workspaceId, systemPrompt: buildSystemPrompt(JSON.stringify(getNodeCatalogView().map((n) => ({ kind: n.kind, inputs: n.inputs.map((p) => p.name), outputs: n.outputs.map((p) => p.name) })))),
          tools: buildAssistTools({ base, state, onTool: (name, summary) => emit('assist.tool', { name, summary }) }),
        });
        await session.send(`${wrapUntrusted(body.data.message)}\n위 요청에 맞는 변경안을 propose_patch로 제출해 주세요.`, 120_000);
        if (!state.proposal && state.repairRounds < MAX_REPAIR_ROUNDS) {
          await session.send('propose_patch 도구로 변경안을 제출해 주세요. validate_patch 오류가 있으면 고쳐서 다시 제출하세요.', 120_000);
        }
        proposalBody = state.proposal?.body;
        if (!proposalBody) failure = 'no_valid_proposal';
      }
      if (!proposalBody) {
        emit('assist.failed', { reason: failure ?? 'no_valid_proposal', message: '적용할 수 있는 변경안을 만들지 못했어요. 요청을 더 구체적으로 적어 주세요' });
      } else {
        const proposalId = randomUUID().slice(0, 12);
        const now = new Date().toISOString();
        await ctx.store.upsert<WorkflowProposalDoc>({
          id: proposalDocId(wid, proposalId), type: 'wfproposal', workspaceId, proposalId, workflowId: wid,
          baseRevision: latest.revision, status: 'pending', message: body.data.message, ...proposalBody, createdAt: now, updatedAt: now, ttl: PROPOSAL_TTL,
        });
        emit('assist.proposal', { proposalId, baseRevision: latest.revision, ...proposalBody });
      }
      emit('assist.completed', {});
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'internal', '도우미가 응답하지 못했어요', true);
      emit('assist.failed', { reason: err.code, message: err.message, retryable: err.retryable });
    } finally {
      void session?.close();
      res.end();
    }
  });

  router.get('/api/workflows/:id/proposals/:pid', async (req, res) => {
    const p = await loadProposal(ws(req), String(req.params.id), String(req.params.pid));
    const { _etag, ...rest } = p;
    res.json({ ...rest, etag: _etag });
  });

  router.post('/api/workflows/:id/proposals/:pid/apply', json, async (req, res) => {
    const workspaceId = ws(req);
    const wid = String(req.params.id);
    const body = revBody.safeParse(req.body);
    if (!body.success) throw new ApiError(400, 'validation_failed', 'baseRevision이 필요해요');
    const p = await loadProposal(workspaceId, wid, String(req.params.pid));
    if (p.status !== 'pending') throw new ApiError(409, 'proposal_closed', '이미 처리된 변경안이에요');
    const latest = await getWorkflowDoc(ctx.store, workspaceId, wid);
    if (!latest) throw new ApiError(404, 'not_found', '워크플로를 찾지 못했어요');
    if (isStaleBase(body.data.baseRevision, latest.revision) || isStaleBase(p.baseRevision, latest.revision)) {
      throw new ApiError(409, 'revision_conflict', staleMessage(latest.revision));
    }
    const ops = patchOpsSchema.parse(p.ops) as PatchOp[];
    const applied = applyOps(latest.definition, ops);
    if (!applied.ok) throw new ApiError(422, 'invalid_proposal', applied.errors.join(' / '));
    const revision = latest.revision + 1;
    const definition: WorkflowDefinition = { ...applied.definition, id: wid, revision };
    const validation = validateDefinition(definition);
    if (!validation.ok) throw new ApiError(422, 'invalid_proposal', validation.errors.map((e) => e.message).join(' / '));
    const now = new Date().toISOString();
    const doc = await saveWorkflowDoc(ctx.store, {
      id: workflowDocId(wid, revision), type: 'workflow', workspaceId, workflowId: wid, revision, status: 'draft',
      definition, validation, origin: 'assistant', createdAt: now, updatedAt: now,
    });
    await ctx.store.upsert<WorkflowProposalDoc>({ ...p, status: 'applied', updatedAt: now, ttl: PROPOSAL_TTL });
    res.json(view(doc));
  });

  router.post('/api/workflows/:id/proposals/:pid/reject', json, async (req, res) => {
    const workspaceId = ws(req);
    const p = await loadProposal(workspaceId, String(req.params.id), String(req.params.pid));
    if (p.status !== 'pending') throw new ApiError(409, 'proposal_closed', '이미 처리된 변경안이에요');
    await ctx.store.upsert<WorkflowProposalDoc>({ ...p, status: 'rejected', updatedAt: new Date().toISOString(), ttl: PROPOSAL_TTL });
    res.json({ proposalId: p.proposalId, status: 'rejected' });
  });
}
