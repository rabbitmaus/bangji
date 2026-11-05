import type { Response } from 'express';

export function startSse(res: Response): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

export function writeSse(res: Response, event: string, data: unknown, id?: string): void {
  if (res.writableEnded) return;
  let out = '';
  if (id) out += `id: ${id}\n`;
  out += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(out);
}
