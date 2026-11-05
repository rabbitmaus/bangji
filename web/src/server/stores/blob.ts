import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { BlobStore } from '../context.js';

export class AzureBlobStore implements BlobStore {
  private container: ContainerClient;
  constructor(endpoint: string) {
    this.container = new BlobServiceClient(endpoint, new DefaultAzureCredential()).getContainerClient('artifacts');
  }
  async put(path: string, data: Buffer | string, contentType: string) {
    const buf = Buffer.from(data);
    await this.container.getBlockBlobClient(path).uploadData(buf, { blobHTTPHeaders: { blobContentType: contentType } });
  }
  async get(path: string) {
    const blob = this.container.getBlockBlobClient(path);
    try {
      const data = await blob.downloadToBuffer();
      const props = await blob.getProperties();
      return { data, contentType: props.contentType ?? 'application/octet-stream' };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return undefined;
      throw e;
    }
  }
  async deletePrefix(prefix: string) {
    for await (const b of this.container.listBlobsFlat({ prefix })) {
      await this.container.deleteBlob(b.name).catch(() => undefined);
    }
  }
  async ping() {
    await this.container.getProperties();
    return true;
  }
}
