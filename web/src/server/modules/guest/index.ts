import type { RegisterModule } from '../../context.js';
import { newWorkspaceId, setGuestCookie } from '../../guest-cookie.js';
import { getLimits } from '../../limits.js';

const guest: RegisterModule = (router, ctx) => {
  router.post('/api/guest', async (req, res) => {
    // 유효한 쿠키가 이미 있으면(미들웨어가 workspaceId 설정) 그대로 재사용한다.
    let workspaceId = req.workspaceId;
    if (!workspaceId) {
      const ip = (req.get('x-forwarded-for')?.split(',')[0]?.trim()) || req.ip || 'unknown';
      getLimits().assertGuestAllowed(ip);
      workspaceId = newWorkspaceId();
      setGuestCookie(req, res, workspaceId, ctx.config.cookieSecret);
    }
    const now = new Date().toISOString();
    const existing = await ctx.store.get(workspaceId, workspaceId);
    await ctx.store.upsert({
      ...(existing ?? { createdAt: now }), id: workspaceId, type: 'workspace', workspaceId, lastSeenAt: now,
    });
    res.status(existing ? 200 : 201).json({ workspaceId });
  });
};
export default guest;
