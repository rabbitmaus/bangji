import { PreconditionFailedError, type BlobStore, type Doc, type DocStore } from '../context.js';

export class MemoryDocStore implements DocStore {
  private docs = new Map<string, Map<string, Doc>>();
  private seq = 0;
  private part(ws: string) {
    let p = this.docs.get(ws);
    if (!p) this.docs.set(ws, (p = new Map()));
    return p;
  }
  private write<T extends Doc>(doc: T): T {
    const stored = { ...structuredClone(doc), _etag: `"${++this.seq}"` } as T;
    this.part(doc.workspaceId).set(doc.id, stored);
    return structuredClone(stored);
  }
  async get<T extends Doc = Doc>(ws: string, id: string) {
    const d = this.docs.get(ws)?.get(id);
    return d ? (structuredClone(d) as T) : undefined;
  }
  async upsert<T extends Doc>(doc: T) { return this.write(doc); }
  async replaceIfMatch<T extends Doc>(doc: T, etag: string) {
    const cur = this.docs.get(doc.workspaceId)?.get(doc.id);
    const bare = (v: string) => v.replace(/^W\//, '').replace(/"/g, '');
    if (!cur || bare(String(cur._etag)) !== bare(etag)) throw new PreconditionFailedError();
    return this.write(doc);
  }
  async list<T extends Doc = Doc>(ws: string, type: string, idPrefix?: string) {
    return [...(this.docs.get(ws)?.values() ?? [])]
      .filter((d) => d.type === type && (!idPrefix || d.id.startsWith(idPrefix)))
      .map((d) => structuredClone(d) as T);
  }
  async delete(ws: string, id: string) { this.docs.get(ws)?.delete(id); }
  async deleteWorkspace(ws: string) { this.docs.delete(ws); }
  async ping() { return true; }
}

export class MemoryBlobStore implements BlobStore {
  private blobs = new Map<string, { data: Buffer; contentType: string }>();
  async put(path: string, data: Buffer | string, contentType: string) {
    this.blobs.set(path, { data: Buffer.from(data), contentType });
  }
  async get(path: string) {
    const b = this.blobs.get(path);
    return b ? { data: Buffer.from(b.data), contentType: b.contentType } : undefined;
  }
  async deletePrefix(prefix: string) {
    for (const k of [...this.blobs.keys()]) if (k.startsWith(prefix)) this.blobs.delete(k);
  }
  async ping() { return true; }
}
