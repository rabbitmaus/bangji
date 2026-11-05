// 브라우저/SSRF 모듈(web-browser 소유)에 대한 얇은 어댑터.
import { ApiError, type AppContext } from '../../context.js';
import { assertUrlAllowed } from '../browser/ssrf.js';
import { openDriver, selectProvider, type PageDriver } from '../browser/driver.js';

export async function assertUrl(url: string, demoOrigin?: string): Promise<void> {
  try {
    await assertUrlAllowed(url, { demoOrigin, allowDemo: !!demoOrigin });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(422, 'blocked_url', '허용되지 않는 주소예요');
  }
}

export interface GuardedPage { page: PageDriver; close(): Promise<void> }

/** demo는 로컬 Playwright, custom은 키가 있으면 Browserbase 세션(실행 후 반드시 close). */
export async function newGuardedPage(ctx: AppContext, sourceKind: 'demo' | 'custom' | 'external'): Promise<GuardedPage> {
  const kind = sourceKind === 'demo' ? 'demo' : 'custom';
  const remote = selectProvider(kind, ctx.config) === 'browserbase';
  if (remote) ctx.assertBrowserSessionAllowed();
  let page: PageDriver;
  try {
    page = await openDriver(ctx, kind);
  } catch (e) {
    if (remote) ctx.releaseBrowserSession();
    throw e;
  }
  let closed = false;
  return {
    page,
    async close() {
      if (closed) return;
      closed = true;
      try { await page.close(); } finally { if (remote) ctx.releaseBrowserSession(); }
    },
  };
}
