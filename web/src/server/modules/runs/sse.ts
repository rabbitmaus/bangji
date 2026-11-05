import type { Response } from 'express';

export interface SseMessage { id?: string; event?: string; data: string }

// 증분 SSE 파서: 청크 경계, CRLF/CR/LF, 여러 줄 data, 주석(:), BOM을 처리한다.
export class SseParser {
  private buf = '';
  private first = true;
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    if (this.first && chunk.length > 0) {
      this.first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    this.buf += chunk;
    const out: SseMessage[] = [];
    let i = 0;
    for (;;) {
      let end = -1;
      let len = 1;
      for (let j = i; j < this.buf.length; j++) {
        const c = this.buf[j];
        if (c === '\n') { end = j; break; }
        if (c === '\r') {
          if (j + 1 >= this.buf.length) { this.buf = this.buf.slice(i); return out; } // \r\n일 수 있어 다음 청크를 기다린다
          end = j;
          if (this.buf[j + 1] === '\n') len = 2;
          break;
        }
      }
      if (end < 0) break;
      const line = this.buf.slice(i, end);
      i = end + len;
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    this.buf = this.buf.slice(i);
    return out;
  }

  // 스트림 종료 시 마지막 미완성 줄과 이벤트를 비운다.
  flush(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buf.length > 0) {
      const msg = this.line(this.buf.replace(/\r$/, ''));
      this.buf = '';
      if (msg) out.push(msg);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id') this.id = value;
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    if (this.data.length === 0) {
      this.event = undefined;
      return undefined;
    }
    const msg: SseMessage = { data: this.data.join('\n'), event: this.event, id: this.id };
    this.data = [];
    this.event = undefined;
    this.id = undefined;
    return msg;
  }
}

export async function* parseSseStream(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const decoder = new TextDecoder('utf-8');
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parser.push(decoder.decode(value, { stream: true }))) yield m;
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      for (const m of parser.push(decoder.decode(chunk, { stream: true }))) yield m;
    }
  }
  for (const m of parser.push(decoder.decode())) yield m;
  for (const m of parser.flush()) yield m;
}

export function formatSse(msg: { id?: string; event?: string; data: unknown }): string {
  const data = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
  let s = '';
  if (msg.id) s += `id: ${msg.id}\n`;
  if (msg.event) s += `event: ${msg.event}\n`;
  for (const l of data.split(/\r\n|\r|\n/)) s += `data: ${l}\n`;
  return s + '\n';
}

export function openSse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
}
