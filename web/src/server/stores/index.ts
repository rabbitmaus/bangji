import type { BlobStore, DocStore } from '../context.js';
import { MemoryBlobStore, MemoryDocStore } from './memory.js';

export type Pingable = { ping?: () => Promise<boolean> };

export async function createStores(): Promise<{ store: DocStore & Pingable; blobs: BlobStore & Pingable; cosmos: boolean; blob: boolean }> {
  const cosmosEndpoint = process.env.COSMOS_ENDPOINT || process.env.COSMOS_ACCOUNT_ENDPOINT || process.env.WORKSPACE_DATA_URI;
  const blobEndpoint = process.env.BLOB_ENDPOINT || process.env.BLOB_ACCOUNT_ENDPOINT || process.env.ARTIFACTS_URI;
  let store: DocStore & Pingable = new MemoryDocStore();
  let blobs: BlobStore & Pingable = new MemoryBlobStore();
  if (cosmosEndpoint) store = new (await import('./cosmos.js')).CosmosDocStore(cosmosEndpoint);
  else console.warn('[stores] COSMOS_ENDPOINT not set; using in-memory store');
  if (blobEndpoint) blobs = new (await import('./blob.js')).AzureBlobStore(blobEndpoint);
  else console.warn('[stores] BLOB_ENDPOINT not set; using in-memory blobs');
  return { store, blobs, cosmos: !!cosmosEndpoint, blob: !!blobEndpoint };
}
