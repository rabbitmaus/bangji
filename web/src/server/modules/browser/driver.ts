import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { browserbase, Stagehand, type StagehandBrowser } from '@browserbasehq/stagehand';
import { ApiError, type AppContext } from '../../context.js';
import { installGuards } from './ssrf.js';

export const VIEWPORT = { width: 1280, height: 800 };

export type Provider = 'local' | 'browserbase';
export type EvalSource = string | ((arg: any) => any);
export interface Evaluate {
  <T = any>(src: string): Promise<T>;
  <A, R>(fn: (arg: A) => R, arg?: A): Promise<Awaited<R>>;
}

/** 세션/수집/미리보기가 쓰는 브라우저 추상화. Playwright 로컬 또는 Browserbase(Stagehand)로 구현된다. */
export interface PageDriver {
  readonly provider: Provider;
  goto(url: string, timeoutMs?: number): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  click(x: number, y: number): Promise<void>;
  scroll(dy: number): Promise<void>;
  evaluate: Evaluate;
  screenshot(): Promise<Buffer>;
  url(): Promise<string>;
  title(): Promise<string>;
  settle(): Promise<void>;
  /** 페이지 load 이벤트 수(pageStateId용). 지원하지 않으면 이동 횟수를 센다. */
  loadCount(): number;
  close(): Promise<void>;
}

export interface DriverSource { kind: 'demo' | 'custom' }

export function blockedError(provider: Provider, status: number): ApiError {
  const hint = provider === 'local'
    ? ' 서버에 BROWSERBASE_API_KEY를 설정하면 차단이 덜한 원격 브라우저로 열 수 있어요'
    : '';
  return new ApiError(502, 'page_blocked', `사이트가 접속을 막았어요(HTTP ${status}).${hint}`, false);
}

const BLOCK_STATUSES = new Set([401, 403, 429]);

// 함수는 소스로 직렬화해 주입한다(esbuild __name 헬퍼 대비 shim 포함).
export function toSource(src: EvalSource, arg: unknown): string {
  if (typeof src === 'string') return src;
  return `(function(){var __name=function(f){return f};return (${src.toString()})(${JSON.stringify(arg ?? null)})})()`;
}

// ---------- 로컬 Playwright ----------

let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  launching ??= chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    .then((b) => { browser = b; b.on('disconnected', () => { if (browser === b) browser = undefined; }); return b; })
    .finally(() => { launching = undefined; });
  return launching;
}

export async function closeLocalBrowser(): Promise<void> {
  await browser?.close().catch(() => {});
}

export class PlaywrightDriver implements PageDriver {
  readonly provider = 'local' as const;
  private loads = 0;
  constructor(readonly page: Page, readonly context: BrowserContext) {
    page.on('load', () => { this.loads++; });
    context.on('page', (p) => { if (p !== page) void p.close().catch(() => {}); });
    page.on('download', (d) => { void d.cancel().catch(() => {}); });
  }
  async goto(url: string, timeoutMs = 20000) {
    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = res?.status();
    if (status && BLOCK_STATUSES.has(status)) throw blockedError('local', status);
  }
  async reload() { await this.page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {}); }
  async back() { await this.page.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {}); }
  async click(x: number, y: number) { await this.page.mouse.click(x, y); }
  async scroll(dy: number) { await this.page.mouse.wheel(0, dy); await this.page.waitForTimeout(200); }
  evaluate: Evaluate = (async (src: EvalSource, arg?: unknown) =>
    typeof src === 'string' ? this.page.evaluate(src) : this.page.evaluate(src, arg)) as Evaluate;
  screenshot() { return this.page.screenshot({ type: 'jpeg', quality: 70 }); }
  async url() { return this.page.url(); }
  async title() { return this.page.title(); }
  async settle() { await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); }
  loadCount() { return this.loads; }
  async close() { await this.context.close().catch(() => {}); }
}

export async function openLocalDriver(opts: { allowDemo: boolean; demoOrigin?: string }): Promise<PlaywrightDriver> {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: VIEWPORT, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: false,
    permissions: [], serviceWorkers: 'block', geolocation: undefined,
  });
  try {
    await installGuards(context, opts);
    const page = await context.newPage();
    return new PlaywrightDriver(page, context);
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

// ---------- Browserbase (Stagehand v4) ----------

export class BrowserbaseDriver implements PageDriver {
  readonly provider = 'browserbase' as const;
  private navs = 0;
  constructor(private readonly bb: StagehandBrowser, private readonly sh: { close?: () => Promise<void> }, private readonly page: Awaited<ReturnType<StagehandBrowser['context']['pages']>>[number]) {}
  async goto(url: string, timeoutMs = 20000) {
    this.navs++;
    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = res?.status();
    if (status && BLOCK_STATUSES.has(status)) throw blockedError('browserbase', status);
  }
  async reload() { this.navs++; await this.page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {}); }
  async back() { this.navs++; await this.page.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {}); }
  async click(x: number, y: number) { this.navs++; await this.page.click(x, y); }
  async scroll(dy: number) { await this.page.scroll(VIEWPORT.width / 2, VIEWPORT.height / 2, 0, dy); await this.page.waitForTimeout(200); }
  async evaluate<T = any, A = any>(src: string | ((arg: A) => any), arg?: A): Promise<T> {
    return (await this.page.evaluate(toSource(src, arg))) as T;
  }
  async screenshot() { return Buffer.from(await this.page.screenshot({ type: 'jpeg', quality: 70 })); }
  async url() { return this.page.url(); }
  async title() { return this.page.title(); }
  async settle() { await this.page.waitForLoadState('networkidle', 5000).catch(() => {}); }
  loadCount() { return this.navs; }
  async close() {
    await this.sh.close?.().catch(() => {});
    await this.bb.close().catch(() => {});
  }
}

export async function openBrowserbaseDriver(apiKey: string): Promise<BrowserbaseDriver> {
  let bb: StagehandBrowser | undefined;
  let sh: Stagehand | undefined;
  try {
    bb = await browserbase.launch({ apiKey, browserSettings: { viewport: VIEWPORT } });
    // browser.context는 Stagehand에 연결한 뒤에만 쓸 수 있다.
    sh = await Stagehand.create({ browser: bb });
    const page = (await bb.context.pages())[0] ?? await bb.context.newPage();
    return new BrowserbaseDriver(bb, sh, page);
  } catch (e) {
    console.warn('[browser] browserbase launch failed:', e instanceof Error ? e.message : e);
    await sh?.close().catch(() => {});
    await bb?.close().catch(() => {});
    throw new ApiError(502, 'browser_unavailable', '원격 브라우저를 열지 못했어요', true);
  }
}

// ---------- 선택 정책 ----------

/** demo는 항상 로컬(Browserbase는 127.0.0.1에 닿을 수 없다). custom은 키가 있으면 Browserbase. */
export function selectProvider(kind: 'demo' | 'custom', config: Pick<AppContext['config'], 'browserbaseApiKey'>): Provider {
  return kind === 'custom' && config.browserbaseApiKey ? 'browserbase' : 'local';
}

export async function openDriver(ctx: AppContext, kind: 'demo' | 'custom'): Promise<PageDriver> {
  if (selectProvider(kind, ctx.config) === 'browserbase') return openBrowserbaseDriver(ctx.config.browserbaseApiKey!);
  return openLocalDriver({ allowDemo: kind === 'demo', demoOrigin: ctx.config.demoBoardOrigin });
}
