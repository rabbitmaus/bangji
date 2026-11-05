import { createHash, randomUUID } from 'node:crypto';
import { ApiError, type AppContext } from '../../context.js';
import { assertUrlAllowed } from './ssrf.js';
import { buildSelector, scoreRepeatingAncestors, type ScoredCandidate } from './region.js';
import { VIEWPORT, closeLocalBrowser, getBrowser, openDriver, toSource, type PageDriver, type Provider } from './driver.js';

export { VIEWPORT, getBrowser };
const IDLE_MS = 5 * 60 * 1000;

export type SourceKind = 'demo' | 'custom';

export interface BrowserSession {
  id: string;
  workspaceId: string;
  kind: SourceKind;
  page: PageDriver;
  seq: number;
  chain: ScoredCandidate[];
  chainIndex: number;
  chainPageStateId?: string;
  idleTimer?: NodeJS.Timeout;
}

let ctxRef: AppContext | undefined;
const sessions = new Map<string, BrowserSession>();

export function configure(ctx: AppContext): void { ctxRef = ctx; }

function appCtx(): AppContext {
  if (!ctxRef) throw new Error('browser module not configured');
  return ctxRef;
}

/** 다른 모듈(assistant 도구, contract preview)이 PageDriver에 접근할 때 쓴다. 소유 불일치/없음이면 undefined. */
export function getSession(workspaceId: string, sessionId: string): BrowserSession | undefined {
  const s = sessions.get(sessionId);
  if (!s || s.workspaceId !== workspaceId) return undefined;
  touch(s);
  return s;
}

export function requireSession(workspaceId: string, sessionId: string): BrowserSession {
  const s = getSession(workspaceId, sessionId);
  if (!s) throw new ApiError(404, 'session_not_found', '브라우저 세션이 없거나 닫혔어요. 새로 열어 주세요');
  return s;
}

function touch(s: BrowserSession): void {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => { void closeSession(s.id); }, IDLE_MS);
  s.idleTimer.unref?.();
}

export async function closeSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  clearTimeout(s.idleTimer);
  await s.page.close().catch(() => {});
  appCtx().releaseBrowserSession();
}

export async function pageStateId(s: BrowserSession): Promise<string> {
  const scrollY = await s.page.evaluate<number>('Math.round(window.scrollY)').catch(() => 0);
  return createHash('sha1').update(`${await s.page.url().catch(() => '')}|${scrollY}|${s.page.loadCount()}`).digest('hex').slice(0, 16);
}

export interface SessionSnapshot {
  sessionId: string;
  url: string;
  title: string;
  pageStateId: string;
  seq: number;
  screenshotUrl: string;
  viewport: { width: number; height: number };
  provider: Provider;
}

export async function screenshot(s: BrowserSession): Promise<SessionSnapshot> {
  const buf = await s.page.screenshot();
  const seq = ++s.seq;
  await appCtx().blobs.put(`ws/${s.workspaceId}/screens/${s.id}/${seq}.jpg`, buf, 'image/jpeg');
  return {
    sessionId: s.id, url: await s.page.url(), title: await s.page.title().catch(() => ''),
    pageStateId: await pageStateId(s), seq,
    screenshotUrl: `/api/browser-sessions/${s.id}/screens/${seq}.jpg`, viewport: VIEWPORT, provider: s.page.provider,
  };
}

export async function createSession(workspaceId: string, url: string, kind: SourceKind): Promise<SessionSnapshot> {
  const ctx = appCtx();
  await assertUrlAllowed(url, { allowDemo: kind === 'demo', demoOrigin: ctx.config.demoBoardOrigin });
  ctx.assertBrowserSessionAllowed();
  let driver: PageDriver | undefined;
  let released = false;
  try {
    driver = await openDriver(ctx, kind);
    const s: BrowserSession = { id: randomUUID(), workspaceId, kind, page: driver, seq: 0, chain: [], chainIndex: 0 };
    sessions.set(s.id, s);
    touch(s);
    try {
      await driver.goto(url);
      await driver.settle();
      return await screenshot(s);
    } catch (e) {
      await closeSession(s.id);
      released = true;
      if (e instanceof ApiError) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn('[browser] page load failed:', reason.split('\n')[0]);
      const blocked = /timeout|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_HTTP2/i.test(reason);
      const hint = blocked
        ? driver?.provider === 'local'
          ? '사이트가 자동화 브라우저의 접속을 응답 없이 끊는 것 같아요. BROWSERBASE_API_KEY를 설정하면 원격 브라우저로 열 수 있어요.'
          : '사이트가 응답하지 않거나 접속을 막았어요. 잠시 뒤 다시 시도해 주세요.'
        : '페이지를 열지 못했어요';
      throw new ApiError(502, 'page_load_failed', hint, true);
    }
  } catch (e) {
    if (!released) {
      await driver?.close().catch(() => {});
      ctx.releaseBrowserSession();
    }
    throw e;
  }
}

export type SessionAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; dy: number }
  | { type: 'back' } | { type: 'reload' };

export async function performAction(s: BrowserSession, a: SessionAction): Promise<SessionSnapshot> {
  switch (a.type) {
    case 'click': await s.page.click(a.x, a.y); break;
    case 'scroll': await s.page.scroll(Math.max(-600, Math.min(600, a.dy))); break;
    case 'back': await s.page.back(); break;
    case 'reload': await s.page.reload(); break;
  }
  await s.page.settle();
  s.chain = [];
  return screenshot(s);
}

// 페이지 안에서 실행: 함수 소스를 직렬화해 주입한다.
export async function evalInPage<T>(page: PageDriver, fn: (...args: any[]) => any, arg: unknown): Promise<T> {
  return page.evaluate<T>(toSource(fn, arg));
}

const BS = buildSelector.toString();
const SC = scoreRepeatingAncestors.toString();

async function runScoring<T>(page: PageDriver, body: string, arg: unknown): Promise<T> {
  const src = `(function(){var __name=function(f){return f};
    var buildSelector=${BS}; var scoreRepeatingAncestors=${SC};
    var arg=${JSON.stringify(arg ?? null)};
    ${body}})()`;
  return page.evaluate<T>(src);
}

export async function resolveRegion(s: BrowserSession, x: number, y: number): Promise<ScoredCandidate[]> {
  const chain = await runScoring<ScoredCandidate[]>(s.page, `
    var el = document.elementFromPoint(arg.x, arg.y);
    if (!el) return [];
    return scoreRepeatingAncestors(el, { mode: 'ancestors', selectorFn: function (n) { return buildSelector(n); } });`, { x, y });
  s.chain = chain;
  s.chainIndex = chain.reduce((best, c, i) => (c.score > chain[best].score ? i : best), 0);
  s.chainPageStateId = await pageStateId(s);
  return chain;
}

export async function recommend(s: BrowserSession): Promise<ScoredCandidate[]> {
  const all = await runScoring<ScoredCandidate[]>(s.page, `
    return scoreRepeatingAncestors(document.body, { mode: 'descendants', selectorFn: function (n) { return buildSelector(n); } });`, null);
  const picked: ScoredCandidate[] = [];
  for (const c of all) {
    // 서로 포개진 후보는 점수가 높은 쪽만 남긴다.
    const overlaps = picked.some((p) => {
      const ix = Math.max(0, Math.min(p.rect.x + p.rect.width, c.rect.x + c.rect.width) - Math.max(p.rect.x, c.rect.x));
      const iy = Math.max(0, Math.min(p.rect.y + p.rect.height, c.rect.y + c.rect.height) - Math.max(p.rect.y, c.rect.y));
      return ix * iy > 0.6 * Math.min(p.rect.width * p.rect.height, c.rect.width * c.rect.height);
    });
    if (!overlaps && c.selector) picked.push(c);
    if (picked.length === 3) break;
  }
  return picked;
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
  await closeLocalBrowser();
}
