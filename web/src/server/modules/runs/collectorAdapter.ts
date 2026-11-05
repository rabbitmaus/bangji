import type { AppContext, Doc } from '../../context.js';
import type { ContractDoc } from '../contract/schema.js';
import type { CollectEvent, CollectOptions, CollectResult as RealResult } from '../collector/index.js';

export type CollectFn = (
  ctx: AppContext, workspaceId: string, contract: ContractDoc, opts: CollectOptions, onEvent: (e: CollectEvent) => void,
) => Promise<RealResult>;

let injected: CollectFn | undefined;
// 테스트에서 실제 브라우저 대신 대역을 꽂는다.
export function setCollector(fn: CollectFn | undefined): void { injected = fn; }

export interface CollectRequest {
  workspaceId: string;
  contract: Doc;
  collectionRunId: string;
  signal: AbortSignal;
  limits: { maxItems: number; maxDetails: number; timeoutSeconds: number };
  onProgress: (done: number, total: number) => void;
}

export interface CollectedItem {
  itemKey: string;
  fields: Record<string, string | null>;
  injectionSuspected: boolean;
  detailMissing: boolean;
  detailBlob?: string;
}

export interface CollectOutcome { collectionRunId: string; status: 'completed' | 'failed'; failureCode?: string; items: CollectedItem[] }

// collector의 collect()는 'crun:' 문서를 쓰지 않으므로 여기서 기록한다. 항목은 저장소의 item 문서에서 다시 읽는다.
export async function runCollection(ctx: AppContext, req: CollectRequest): Promise<CollectOutcome> {
  const collect: CollectFn = injected ?? (await import('../collector/index.js')).collect;
  const res = await collect(ctx, req.workspaceId, req.contract as ContractDoc, {
    collectionRunId: req.collectionRunId, signal: req.signal,
    maxItems: req.limits.maxItems, maxDetails: req.limits.maxDetails, runSeconds: req.limits.timeoutSeconds,
  }, (e) => {
    if (e.type === 'collect.progress') req.onProgress(Number(e.data.done ?? 0), Number(e.data.total ?? 0));
  });
  await ctx.store.upsert({
    id: `crun:${req.collectionRunId}`, type: 'collectionRun', workspaceId: req.workspaceId,
    collectionRunId: req.collectionRunId, status: res.status, failureCode: res.failureCode,
    contractId: res.contractId, contractVersion: res.contractVersion, total: res.total, skippedItems: res.skippedItems,
    createdAt: new Date().toISOString(), ttl: 604800,
  });
  return {
    collectionRunId: req.collectionRunId, status: res.status, failureCode: res.failureCode,
    items: await loadItems(ctx, req.workspaceId, req.collectionRunId, req.limits.maxItems),
  };
}

export async function loadItems(ctx: AppContext, workspaceId: string, collectionRunId: string, max = Infinity): Promise<CollectedItem[]> {
  const docs = await ctx.store.list<any>(workspaceId, 'item', `item:${collectionRunId}:`);
  return docs.slice(0, max).map((d) => {
    const detailBlob = d.detailSnapshot?.blob as string | undefined;
    return {
      itemKey: String(d.itemKey ?? d.id.slice(`item:${collectionRunId}:`.length)),
      fields: (d.fields ?? {}) as Record<string, string | null>,
      injectionSuspected: Boolean(d.injectionSuspected),
      detailMissing: d.detailStatus !== 'ok' || !detailBlob,
      detailBlob,
    };
  });
}
