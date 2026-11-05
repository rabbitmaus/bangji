import { randomBytes } from 'node:crypto';
import type { Router } from 'express';
import { ApiError, PreconditionFailedError, type RegisterModule } from '../../context.js';
import { assertUrl, newGuardedPage } from '../collector/browserAdapter.js';
import { extractItems, probeContainer } from './extract.js';
import { mapFields } from './mapping.js';
import { contractBodySchema, previewRequestSchema, saveRequestSchema, type ContractDoc } from './schema.js';

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ApiError(400, 'validation_failed', `${i?.path.join('.') ?? ''} ${i?.message ?? '입력이 올바르지 않아요'}`.trim());
  }
  return r.data;
}

function wsId(req: { workspaceId?: string }): string {
  if (!req.workspaceId) throw new ApiError(401, 'no_guest', '게스트 세션이 필요해요');
  return req.workspaceId;
}

const mod: RegisterModule = (router: Router, ctx) => {
  router.post('/api/contracts/preview', async (req, res, next) => {
    let gp: Awaited<ReturnType<typeof newGuardedPage>> | undefined;
    try {
      wsId(req);
      const b = parse(previewRequestSchema, req.body);
      const demoOrigin = b.source.kind === 'demo' ? ctx.config.demoBoardOrigin : undefined;
      await assertUrl(b.source.startUrl, demoOrigin);
      gp = await newGuardedPage(ctx, b.source.kind);
      await gp.page.goto(b.source.startUrl, 15000);
      await gp.page.settle();
      const { item, probe } = await probeContainer(gp.page, b.container, b.item);
      const fields = b.fields?.length ? b.fields : mapFields(probe.candidates);
      const data = await extractItems(gp.page, b.container, item, fields, b.sampleCount ?? 5);
      res.json({ container: b.container, item, itemCount: probe.count, fields, rows: data?.rows ?? [], mapping: b.fields?.length ? 'user' : 'auto' });
    } catch (e) { next(e); } finally { await gp?.close().catch(() => undefined); }
  });

  router.post('/api/contracts', async (req, res, next) => {
    try {
      const ws = wsId(req);
      const b = parse(saveRequestSchema, req.body);
      const { contractId: given, ...body } = b;
      const cbody = parse(contractBodySchema, body);
      const contractId = given ?? randomBytes(4).toString('hex');
      const existing = (await ctx.store.list<ContractDoc>(ws, 'contract', `contract:${contractId}:v`)).sort((a, z) => z.version - a.version);
      const latest = existing[0];
      const ifMatch = req.header('If-Match');
      if (latest && ifMatch && ifMatch !== latest._etag) throw new PreconditionFailedError();
      if (given && !latest) throw new ApiError(404, 'not_found', '계약을 찾을 수 없어요');
      const version = (latest?.version ?? 0) + 1;
      if (latest) await ctx.store.upsert({ ...latest, status: 'superseded' });
      const doc: ContractDoc = { ...cbody, id: `contract:${contractId}:v${version}`, type: 'contract', workspaceId: ws, version, status: 'active' };
      const saved = await ctx.store.upsert(doc);
      if (saved._etag) res.setHeader('ETag', String(saved._etag));
      res.status(201).json({ contractId, ...saved });
    } catch (e) { next(e); }
  });
};

export default mod;
