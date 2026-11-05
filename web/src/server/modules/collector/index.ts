import { createHash } from 'node:crypto';
import type { AppContext, Doc } from '../../context.js';
import { ApiError } from '../../context.js';
import type { ContractDoc } from '../contract/schema.js';
import { extractItems } from '../contract/extract.js';
import { assertUrl, newGuardedPage } from './browserAdapter.js';
import { detectInjection } from './injection.js';

export { detectInjection } from './injection.js';

export interface CollectOptions {
  collectionRunId: string;
  signal?: AbortSignal;
  maxItems?: number;      // 기본: min(계약, ctx.config.limits.maxItems)
  maxDetails?: number;
  runSeconds?: number;
}
export interface CollectEvent { type: 'item.collected' | 'collect.progress'; data: Record<string, unknown> }

export interface ItemDoc extends Doc {
  type: 'item'; collectionRunId: string; itemKey: string; fields: Record<string, string | null>;
  fieldErrors: { field: string; code: 'field_missing' }[];
  detailStatus: 'ok' | 'detail_missing' | 'timeout';
  listSnapshot: { blob: string; sha256: string };
  detailSnapshot?: { blob: string; sha256: string };
  injectionSuspected: boolean; injectionMatches: string[]; ttl?: number;
}
export interface CollectResult {
  status: 'completed' | 'failed'; failureCode?: string; contractId: string; contractVersion: number;
  items: ItemDoc[]; skippedItems: number; total: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safeKey = (k: string) => k.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

export function itemKeyFor(detailUrl: string | null, fields: Record<string, string | null>): string {
  if (detailUrl) {
    try { const u = new URL(detailUrl); return safeKey((u.pathname.split('/').filter(Boolean).pop() ?? '') || sha(detailUrl).slice(0, 12)); } catch { /* 해시로 */ }
  }
  return sha(JSON.stringify(fields)).slice(0, 12);
}

export async function collect(
  ctx: AppContext, workspaceId: string, contract: ContractDoc, opts: CollectOptions, onEvent: (e: CollectEvent) => void,
): Promise<CollectResult> {
  const demoOrigin = contract.source.kind === 'demo' ? ctx.config.demoBoardOrigin : undefined;
  const maxItems = Math.min(opts.maxItems ?? contract.limits.maxItems, ctx.config.limits.maxItems, contract.limits.maxItems);
  const maxDetails = Math.min(opts.maxDetails ?? contract.limits.maxDetails, ctx.config.limits.maxDetails, contract.limits.maxDetails);
  const deadline = Date.now() + Math.min(opts.runSeconds ?? contract.limits.timeoutSeconds, ctx.config.limits.runSeconds, contract.limits.timeoutSeconds) * 1000;
  const base = { contractId: contract.id.split(':')[1]!, contractVersion: contract.version };
  const fail = (failureCode: string): CollectResult => ({ status: 'failed', failureCode, ...base, items: [], skippedItems: 0, total: 0 });
  const allowed = new Set(contract.source.allowedHosts.map((h) => h.toLowerCase()));

  await assertUrl(contract.source.startUrl, demoOrigin);
  const gp = await newGuardedPage(ctx, contract.source.kind);
  try {
    const { page } = gp;
    await page.goto(contract.source.startUrl, 15000);
    await page.settle();
    const baseUrl = await page.url();
    const listHtml = await page.evaluate((c: string) => document.querySelector(c)?.textContent ?? null, contract.container).catch(() => null);
    const data = await extractItems(page, contract.container, contract.item, contract.fields, maxItems);
    if (!data || listHtml === null) return fail('container_not_found');

    const total = data.total;
    const items: ItemDoc[] = [];
    const prefix = `ws/${workspaceId}/snapshots/${opts.collectionRunId}`;
    let detailsDone = 0;
    let failedCount = 0;
    onEvent({ type: 'collect.progress', data: { done: 0, total: data.rows.length } });

    for (const [i, row] of data.rows.entries()) {
      if (opts.signal?.aborted) throw new ApiError(499, 'cancelled', '취소됐어요');
      const fields: Record<string, string | null> = { ...row };
      const fieldErrors: ItemDoc['fieldErrors'] = [];
      for (const f of contract.fields) if (f.required && !fields[f.key]) fieldErrors.push({ field: f.key, code: 'field_missing' });

      let detailUrl: string | null = null;
      if (fields.detailUrl) {
        try {
          const u = new URL(fields.detailUrl, baseUrl);
          if (allowed.has(u.hostname.toLowerCase()) && /^https?:$/.test(u.protocol)) detailUrl = u.toString();
          else fieldErrors.push({ field: 'detailUrl', code: 'field_missing' });
        } catch { fieldErrors.push({ field: 'detailUrl', code: 'field_missing' }); }
        fields.detailUrl = detailUrl;
      }
      if (fieldErrors.length) failedCount++;

      const itemKey = itemKeyFor(detailUrl, fields);
      const listText = JSON.stringify(fields);
      const listBlob = `${prefix}/${itemKey}.list.txt`;
      await ctx.blobs.put(listBlob, listText, 'text/plain; charset=utf-8');

      let detailStatus: ItemDoc['detailStatus'] = 'detail_missing';
      let detailSnapshot: ItemDoc['detailSnapshot'];
      let detailText = '';
      if (detailUrl && detailsDone < maxDetails) {
        if (Date.now() > deadline) detailStatus = 'timeout';
        else {
          detailsDone++;
          try {
            await assertUrl(detailUrl, demoOrigin);
            await page.goto(detailUrl, 10000);
            detailText = (await page.evaluate(() => document.body?.innerText ?? '')).trim().slice(0, 20000);
            if (detailText) {
              const blob = `${prefix}/${itemKey}.txt`;
              await ctx.blobs.put(blob, detailText, 'text/plain; charset=utf-8');
              detailSnapshot = { blob, sha256: sha(detailText) };
              detailStatus = 'ok';
            }
          } catch { /* detail_missing */ }
        }
      }

      const inj = detectInjection(`${listText}\n${detailText}`);
      const doc: ItemDoc = {
        id: `item:${opts.collectionRunId}:${itemKey}`, type: 'item', workspaceId, collectionRunId: opts.collectionRunId, itemKey,
        fields, fieldErrors, detailStatus, listSnapshot: { blob: listBlob, sha256: sha(listText) }, detailSnapshot,
        injectionSuspected: inj.suspected, injectionMatches: inj.matches,
      };
      await ctx.store.upsert(doc);
      items.push(doc);
      onEvent({ type: 'item.collected', data: { itemKey, fields: { company: fields.company, title: fields.title }, fieldErrors, detailStatus, injectionSuspected: inj.suspected } });
      onEvent({ type: 'collect.progress', data: { done: i + 1, total: data.rows.length } });
    }

    if (items.length > 0 && failedCount > items.length / 2) return { ...fail('field_missing'), items, total };
    return { status: 'completed', ...base, items, skippedItems: Math.max(0, total - items.length), total };
  } finally {
    await gp.close().catch(() => undefined);
  }
}
