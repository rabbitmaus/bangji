import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

export const COOKIE_NAME = 'bangji_guest';
export const COOKIE_MAX_AGE_MS = 7 * 24 * 3600_000;

const sign = (id: string, secret: string) => createHmac('sha256', secret).update(id).digest('base64url');

export function newWorkspaceId(): string {
  return randomBytes(16).toString('hex');
}

export function signValue(workspaceId: string, secret: string): string {
  return `${workspaceId}.${sign(workspaceId, secret)}`;
}

export function verifyValue(value: string | undefined, secret: string): string | undefined {
  if (!value) return undefined;
  const i = value.lastIndexOf('.');
  if (i <= 0) return undefined;
  const id = value.slice(0, i);
  if (!/^[0-9a-f]{32}$/.test(id)) return undefined;
  const a = Buffer.from(value.slice(i + 1));
  const b = Buffer.from(sign(id, secret));
  return a.length === b.length && timingSafeEqual(a, b) ? id : undefined;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

function secureFlag(req: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  const host = req.hostname;
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

export function setGuestCookie(req: Request, res: Response, workspaceId: string, secret: string): void {
  res.cookie(COOKIE_NAME, signValue(workspaceId, secret), {
    httpOnly: true, secure: secureFlag(req), sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS, path: '/',
  });
}

export function clearGuestCookie(req: Request, res: Response): void {
  res.cookie(COOKIE_NAME, '', { httpOnly: true, secure: secureFlag(req), sameSite: 'lax', maxAge: 0, expires: new Date(0), path: '/' });
}
