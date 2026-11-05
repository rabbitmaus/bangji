export interface SseMessage {
  id?: string;
  event: string;
  data: unknown;
}

/** 줄 단위 SSE 블록 파서. 완성된 블록만 내보내고 남은 버퍼를 돌려준다. */
export function parseSseChunk(buffer: string): { messages: SseMessage[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const messages: SseMessage[] = [];
  for (const block of blocks) {
    let id: string | undefined;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 텍스트 그대로 */
    }
    messages.push({ id, event, data });
  }
  return { messages, rest };
}

export class StreamError extends Error {
  status: number;
  code?: string;
  retryable?: boolean;
  constructor(status: number, message: string, code?: string, retryable?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** POST 요청의 SSE 응답을 fetch 스트림으로 읽는다(TRD 8.1). */
export async function postSse(
  url: string,
  body: unknown,
  onMessage: (m: SseMessage) => void,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `요청에 실패했어요 (${res.status})`;
    let code: string | undefined;
    let retryable: boolean | undefined;
    try {
      const j = await res.json();
      message = j?.error?.message ?? message;
      code = j?.error?.code;
      retryable = j?.error?.retryable;
    } catch {
      /* ignore */
    }
    throw new StreamError(res.status, message, code, retryable);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { messages, rest } = parseSseChunk(buffer);
    buffer = rest;
    messages.forEach(onMessage);
  }
  buffer += decoder.decode();
  if (buffer.trim()) parseSseChunk(buffer + '\n\n').messages.forEach(onMessage);
}
