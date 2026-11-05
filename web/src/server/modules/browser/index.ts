import type { Request } from 'express';
import { ApiError, type RegisterModule } from '../../context.js';
import {
  configure, createSession, getSession, performAction, pageStateId, recommend, requireSession, resolveRegion,
  screenshot, VIEWPORT, type BrowserSession, type SessionAction, type SourceKind,
} from './sessions.js';
import type { ScoredCandidate } from './region.js';

function wsId(req: Request): string {
  if (!req.workspaceId) throw new ApiError(401, 'no_guest', '게스트 세션이 필요해요');
  return req.workspaceId;
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, 'bad_request', `${name} 값이 올바르지 않아요`);
  return v;
};

function regionView(c: ScoredCandidate, i: number, total: number) {
  return {
    selector: c.selector, tag: c.tag, itemCount: c.itemCount, score: c.score, similarity: c.similarity,
    rect: c.rect, sampleText: c.sampleText, chainIndex: i, canWiden: i < total - 1, canNarrow: i > 0,
  };
}

async function regionResponse(s: BrowserSession) {
  const snap = await screenshot(s);
  const c = s.chain[s.chainIndex];
  return { ...snap, region: c ? regionView(c, s.chainIndex, s.chain.length) : null };
}

const register: RegisterModule = (router, ctx) => {
  configure(ctx);

  router.post('/api/browser-sessions', async (req, res, next) => {
    try {
      const ws = wsId(req);
      const kind: SourceKind = req.body?.kind === 'demo' ? 'demo' : 'custom';
      let url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!url && kind === 'demo') url = new URL('/demo/jobs', ctx.config.demoBoardOrigin).toString();
      if (!url) throw new ApiError(400, 'bad_request', '수집처 주소를 알려 주세요');
      res.status(201).json(await createSession(ws, url, kind));
    } catch (e) { next(e); }
  });

  router.get('/api/browser-sessions/:id/screens/:file', async (req, res, next) => {
    try {
      const ws = wsId(req);
      const m = /^(\d+)\.jpg$/.exec(String(req.params.file));
      if (!m || !/^[\w-]+$/.test(String(req.params.id))) throw new ApiError(404, 'not_found', '화면을 찾을 수 없어요');
      // 경로에 요청자의 workspaceId가 들어가므로 소유 확인이 된다.
      const blob = await ctx.blobs.get(`ws/${ws}/screens/${req.params.id}/${m[1]}.jpg`);
      if (!blob) throw new ApiError(404, 'not_found', '화면을 찾을 수 없어요');
      res.set('Cache-Control', 'private, max-age=300').type(blob.contentType).send(blob.data);
    } catch (e) { next(e); }
  });

  router.post('/api/browser-sessions/:id/actions', async (req, res, next) => {
    try {
      const s = requireSession(wsId(req), String(req.params.id));
      const b = req.body ?? {};
      const scale = typeof b.imageWidth === 'number' && b.imageWidth > 0 ? VIEWPORT.width / b.imageWidth : 1;
      let action: SessionAction;
      switch (b.type) {
        case 'click': action = { type: 'click', x: num(b.x, 'x') * scale, y: num(b.y, 'y') * scale }; break;
        case 'scroll': action = { type: 'scroll', dy: num(b.dy ?? (b.direction === 'up' ? -600 : 600), 'dy') }; break;
        case 'back': case 'reload': action = { type: b.type }; break;
        default: throw new ApiError(400, 'bad_request', '지원하지 않는 동작이에요');
      }
      res.json(await performAction(s, action));
    } catch (e) { next(e); }
  });

  router.post('/api/browser-sessions/:id/region', async (req, res, next) => {
    try {
      const s = requireSession(wsId(req), String(req.params.id));
      const b = req.body ?? {};
      if (typeof b.pageStateId === 'string' && b.pageStateId !== (await pageStateId(s))) {
        const snap = await screenshot(s);
        throw Object.assign(new ApiError(409, 'page_state_changed', '화면이 바뀌었어요. 새 화면에서 다시 골라 주세요'), { body: snap });
      }
      if (b.mode === 'resolve') {
        const scale = typeof b.imageWidth === 'number' && b.imageWidth > 0 ? VIEWPORT.width / b.imageWidth : 1;
        const chain = await resolveRegion(s, num(b.x, 'x') * scale, num(b.y, 'y') * scale);
        if (chain.length === 0) throw new ApiError(422, 'no_region', '반복되는 영역을 찾지 못했어요. 다른 곳을 눌러 보세요');
      } else if (b.mode === 'parent' || b.mode === 'child') {
        if (s.chain.length === 0) throw new ApiError(409, 'no_region_selected', '먼저 영역을 골라 주세요');
        const next = s.chainIndex + (b.mode === 'parent' ? 1 : -1);
        if (next < 0 || next >= s.chain.length) throw new ApiError(422, 'region_limit', b.mode === 'parent' ? '더 넓힐 수 없어요' : '더 좁힐 수 없어요');
        s.chainIndex = next;
      } else throw new ApiError(400, 'bad_request', 'mode는 resolve, parent, child 중 하나예요');
      res.json(await regionResponse(s));
    } catch (e) { next(e); }
  });

  router.get('/api/browser-sessions/:id/recommendations', async (req, res, next) => {
    try {
      const s = requireSession(wsId(req), String(req.params.id));
      const cands = await recommend(s);
      const names = new Map<number, { name: string; reason: string }>();
      try {
        const spec = '../copilot/naming.js';
        const mod = await import(spec);
        if (typeof mod.nameCandidates === 'function') {
          const r = await Promise.race([
            mod.nameCandidates(wsId(req), cands.map((c, i) => ({ id: String(i), tag: c.tag, repeatCount: c.itemCount, sampleTexts: [c.sampleText], score: c.score }))),
            new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
          ]);
          if (Array.isArray(r)) for (const n of r) names.set(Number(n.id), n);
        }
      } catch { /* Copilot 이름 붙이기는 선택 사항 */ }
      const snap = await pageStateId(s);
      res.json({
        pageStateId: snap,
        recommendations: cands.map((c, i) => ({
          rank: i + 1, label: names.get(i)?.name || '구조 기반 추천',
          reason: names.get(i)?.reason || `비슷한 항목 ${c.itemCount}개가 반복돼요`,
          selector: c.selector, itemCount: c.itemCount, score: c.score, rect: c.rect, sampleText: c.sampleText,
        })),
      });
    } catch (e) { next(e); }
  });
};

export { getSession };
export default register;
