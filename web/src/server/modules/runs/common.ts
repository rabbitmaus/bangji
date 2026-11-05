import type { Request } from 'express';
import { ApiError, type AppContext, type Doc } from '../../context.js';
import { EventHub } from './eventHub.js';

const hubs = new WeakMap<object, EventHub>();
export function getHub(ctx: AppContext): EventHub {
  let h = hubs.get(ctx);
  if (!h) { h = new EventHub(ctx.store); hubs.set(ctx, h); }
  return h;
}

export function wsOf(req: Request): string {
  if (!req.workspaceId) throw new ApiError(401, 'unauthorized', '게스트 세션이 필요해요');
  return req.workspaceId;
}

export function notFound(): never { throw new ApiError(404, 'not_found', '찾을 수 없어요'); }
export function invalid(msg: string): never { throw new ApiError(400, 'validation_failed', msg); }

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) invalid(`${name} 값이 필요해요`);
  return v as string;
}

// Idempotency-Key: 같은 키로 다시 오면 처음 만든 리소스 ID를 돌려준다.
export async function idempotent(ctx: AppContext, req: Request, scope: string): Promise<{ existing?: string; remember(resourceId: string): Promise<void> }> {
  const key = req.header('Idempotency-Key');
  const ws = wsOf(req);
  if (!key) return { remember: async () => undefined };
  const id = `idem:${scope}:${key.slice(0, 120)}`;
  const found = await ctx.store.get<Doc & { resourceId?: string }>(ws, id);
  return {
    existing: found?.resourceId,
    remember: async (resourceId) => { await ctx.store.upsert({ id, type: 'idempotency', workspaceId: ws, resourceId, ttl: 86400 }); },
  };
}

export async function latestVersioned<T extends Doc>(ctx: AppContext, ws: string, type: string, prefix: string, version?: number): Promise<T | undefined> {
  if (version) return ctx.store.get<T>(ws, `${prefix}:v${version}`);
  const docs = await ctx.store.list<T>(ws, type, `${prefix}:v`);
  return docs.sort((a, b) => Number((b as any).version ?? 0) - Number((a as any).version ?? 0))[0];
}
