import type { RegisterModule } from '../../context.js';
import { clearGuestCookie } from '../../guest-cookie.js';

const workspace: RegisterModule = (router, ctx) => {
  router.delete('/api/workspace', async (req, res) => {
    const ws = req.workspaceId!;
    await ctx.store.deleteWorkspace(ws);
    await ctx.blobs.deletePrefix(`ws/${ws}/`);
    clearGuestCookie(req, res);
    res.status(204).end();
  });
};
export default workspace;
