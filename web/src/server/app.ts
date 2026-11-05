import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { ApiError, MODULE_NAMES, type AppContext, type Config, type RegisterModule } from './context.js';
import { errorMiddleware } from './errors.js';
import { COOKIE_NAME, readCookie, verifyValue } from './guest-cookie.js';
import { initLimits } from './limits.js';
import { createStores } from './stores/index.js';

const VERSION = process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.0';

function isPublic(req: Request): boolean {
  const p = req.path;
  return (req.method === 'POST' && p === '/guest') || (req.method === 'GET' && p === '/demo/seed-run');
}

export async function createApp(config: Config, stores?: Awaited<ReturnType<typeof createStores>>) {
  const s = stores ?? (await createStores());
  const limits = initLimits(config.limits);
  const ctx: AppContext = {
    config, store: s.store, blobs: s.blobs,
    assertRunAllowed: (ws) => limits.assertRunAllowed(ws),
    assertPrepAllowed: (ws) => limits.assertPrepAllowed(ws),
    assertAssistantAllowed: (ws) => limits.assertAssistantAllowed(ws),
    assertBrowserSessionAllowed: () => limits.assertBrowserSessionAllowed(),
    releaseBrowserSession: () => limits.releaseBrowserSession(),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', async (_req, res) => {
    const check = async (fn?: () => Promise<boolean>) => {
      if (!fn) return 'memory';
      try { return (await fn()) ? 'ok' : 'down'; } catch { return 'down'; }
    };
    const evaluator = await (async () => {
      try {
        const r = await fetch(new URL('/health', config.evaluatorUrl), { signal: AbortSignal.timeout(2000) });
        return r.ok ? 'ok' : 'down';
      } catch { return 'down'; }
    })();
    const cosmos = s.cosmos ? await check(() => s.store.ping!()) : 'memory';
    const blob = s.blob ? await check(() => s.blobs.ping!()) : 'memory';
    const ok = cosmos !== 'down' && blob !== 'down';
    res.status(ok ? 200 : 503).json({ web: 'ok', evaluator, cosmos, blob, browser: config.browserbaseApiKey ? 'browserbase' : 'local', version: VERSION });
  });

  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  // Origin 검사: 상태를 바꾸는 요청은 자기 출처만 허용한다.
  api.use((req: Request, _res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let host: string | undefined;
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (host !== req.get('host')) return next(new ApiError(403, 'bad_origin', '허용되지 않은 요청이에요'));
    }
    next();
  });
  api.use((req: Request, _res: Response, next: NextFunction) => {
    const id = verifyValue(readCookie(req.headers.cookie, COOKIE_NAME), config.cookieSecret);
    if (id) req.workspaceId = id;
    else if (!isPublic(req)) return next(new ApiError(401, 'no_guest', '먼저 게스트로 시작해 주세요'));
    next();
  });
  app.use('/api', api);

  // 모듈은 `/api/...` 전체 경로로 라우트를 등록하므로 앱 루트에 붙인 라우터를 쓴다.
  const router = express.Router();
  for (const name of MODULE_NAMES) {
    try {
      const mod = await import(`./modules/${name}/index.js`);
      await (mod.default as RegisterModule)(router, ctx);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') console.warn(`[app] module '${name}' missing; skipped`);
      else throw e;
    }
  }
  app.use(router);
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'not_found', '찾을 수 없어요')));

  const uiDir = path.resolve(import.meta.dirname, '../ui');
  const uiDirAlt = path.resolve(process.cwd(), 'dist/ui');
  const root = existsSync(uiDir) ? uiDir : uiDirAlt;
  app.use(express.static(root));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/demo/')) return next();
    res.sendFile(path.join(root, 'index.html'), (err) => err && next());
  });

  app.use(errorMiddleware);
  return app;
}
