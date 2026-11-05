import type { ErrorRequestHandler } from 'express';
import { ApiError } from './context.js';

export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    const body = (err as ApiError & { body?: Record<string, unknown> }).body;
    res.status(err.status).set(err.headers).json({ error: { code: err.code, message: err.message, retryable: err.retryable }, ...(body ?? {}) });
    return;
  }
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[error]', err?.name, err?.message);
  res.status(status).json({
    error: { code: status === 500 ? 'internal_error' : 'bad_request', message: status === 500 ? '잠시 후 다시 시도해 주세요' : '요청을 처리할 수 없어요', retryable: status === 500 },
  });
};
