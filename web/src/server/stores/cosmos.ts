import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { PreconditionFailedError, type Doc, type DocStore } from '../context.js';

export class CosmosDocStore implements DocStore {
  private container: Container;
  private client: CosmosClient;
  constructor(endpoint: string) {
    this.client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    this.container = this.client.database('bangji').container('workspace-data');
  }
  async get<T extends Doc = Doc>(ws: string, id: string) {
    const { resource } = await this.container.item(id, ws).read<T>();
    return resource as T | undefined;
  }
  async upsert<T extends Doc>(doc: T) {
    const { resource } = await this.container.items.upsert<T>(doc);
    return resource as unknown as T;
  }
  async replaceIfMatch<T extends Doc>(doc: T, etag: string) {
    try {
      const { resource } = await this.container.item(doc.id, doc.workspaceId).replace<T>(doc, { accessCondition: { type: 'IfMatch', condition: `"${etag.replace(/^W\//, '').replace(/"/g, '')}"` } });
      return resource as unknown as T;
    } catch (e) {
      if ((e as { code?: number }).code === 412 || (e as { code?: number }).code === 404) throw new PreconditionFailedError();
      throw e;
    }
  }
  async list<T extends Doc = Doc>(ws: string, type: string, idPrefix?: string) {
    const query = idPrefix
      ? { query: 'SELECT * FROM c WHERE c.type = @t AND STARTSWITH(c.id, @p)', parameters: [{ name: '@t', value: type }, { name: '@p', value: idPrefix }] }
      : { query: 'SELECT * FROM c WHERE c.type = @t', parameters: [{ name: '@t', value: type }] };
    const { resources } = await this.container.items.query<T>(query, { partitionKey: ws }).fetchAll();
    return resources;
  }
  async delete(ws: string, id: string) {
    try { await this.container.item(id, ws).delete(); } catch (e) {
      if ((e as { code?: number }).code !== 404) throw e;
    }
  }
  async deleteWorkspace(ws: string) {
    const { resources } = await this.container.items.query<{ id: string }>({ query: 'SELECT c.id FROM c' }, { partitionKey: ws }).fetchAll();
    for (const r of resources) await this.delete(ws, r.id);
  }
  async ping() {
    await this.container.read();
    return true;
  }
}
