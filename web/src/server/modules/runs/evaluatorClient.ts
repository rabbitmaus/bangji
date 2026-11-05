import { randomBytes } from 'node:crypto';
import { ApiError } from '../../context.js';
import { parseSseStream } from './sse.js';

export interface EvaluatorEvent { event: string; data: Record<string, any> }

export function newTraceId(): string { return randomBytes(16).toString('hex'); }
export function traceparent(traceId: string): string { return `00-${traceId}-${randomBytes(8).toString('hex')}-01`; }

function headers(traceId: string, extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', traceparent: traceparent(traceId), ...extra };
}

export async function evaluatorJson<T = any>(baseUrl: string, path: string, opts: {
  method?: string; body?: unknown; traceId?: string; signal?: AbortSignal;
}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? 'POST',
      headers: headers(opts.traceId ?? newTraceId()),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(502, 'evaluator_unavailable', '평가 서비스에 연결하지 못했어요', true);
  }
  if (!res.ok) throw new ApiError(res.status === 404 ? 404 : 502, res.status === 404 ? 'not_found' : 'evaluator_error', `평가 서비스 오류(${res.status})`, res.status >= 500);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// 평가기 SSE를 열어 이벤트를 하나씩 돌려준다. 연결 실패는 ApiError(502)로 던진다.
export async function* evaluatorStream(baseUrl: string, path: string, opts: {
  body: unknown; traceId: string; signal?: AbortSignal;
}): AsyncGenerator<EvaluatorEvent> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: headers(opts.traceId, { accept: 'text/event-stream' }),
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new ApiError(502, 'evaluator_unavailable', '평가 서비스에 연결하지 못했어요', true);
  }
  if (!res.ok || !res.body) {
    throw new ApiError(res.status === 404 || res.status === 410 ? res.status : 502, 'evaluator_error', `평가 서비스 오류(${res.status})`, res.status >= 500);
  }
  for await (const m of parseSseStream(res.body)) {
    let data: Record<string, any> = {};
    try { data = m.data ? JSON.parse(m.data) : {}; } catch { data = { text: m.data }; }
    yield { event: m.event ?? 'message', data };
  }
}
