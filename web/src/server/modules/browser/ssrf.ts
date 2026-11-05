import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserContext, Route } from 'playwright';
import { ApiError } from '../../context.js';

function parseV4(ip: string): number[] | undefined {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : undefined;
}

// IPv6 문자열을 8개의 16비트 그룹으로 푼다.
function parseV6(ip: string): number[] | undefined {
  let s = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseV4(tail[1]);
    if (!v4) return undefined;
    s = s.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : undefined;
}

/** IP 리터럴이 막아야 할 주소(loopback/사설/link-local/메타데이터/미지정)이면 true. 해석 불가도 true. */
export function isBlockedIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '');
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(parseV4(ip));
  if (fam === 6) {
    const g = parseV6(ip);
    if (!g) return true;
    // IPv4-mapped(::ffff:a.b.c.d)와 IPv4-compatible은 IPv4 규칙으로 검사
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return isBlockedV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
    }
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    return false;
  }
  return true;
}

function isBlockedV4(p: number[] | undefined): boolean {
  if (!p) return true;
  const [a, b] = p;
  return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** 호스트 이름 자체로 막아야 하는지(점 없는 이름, .internal. 도메인, localhost). IP 리터럴은 여기서 판단하지 않는다. */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (isIP(h)) return false;
  if (!h.includes('.')) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  return h.includes('.internal.') || h.endsWith('.internal');
}

export interface SsrfOptions { demoOrigin?: string; allowDemo: boolean }

function isDemoUrl(u: URL, opts: SsrfOptions): boolean {
  if (!opts.allowDemo || !opts.demoOrigin) return false;
  try { return u.origin === new URL(opts.demoOrigin).origin; } catch { return false; }
}

/** 허용되지 않으면 사유 문자열, 허용이면 undefined. */
export async function checkUrl(raw: string, opts: SsrfOptions): Promise<string | undefined> {
  let u: URL;
  try { u = new URL(raw); } catch { return '주소 형식이 올바르지 않아요'; }
  if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return undefined;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http, https 주소만 쓸 수 있어요';
  if (isDemoUrl(u, opts)) return undefined;
  if (u.username || u.password) return '주소에 사용자 정보를 넣을 수 없어요';
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') return '80, 443 포트만 쓸 수 있어요';
  if (isBlockedHostname(u.hostname)) return '접근할 수 없는 주소예요';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isBlockedIp(host) ? '접근할 수 없는 주소예요' : undefined;
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) return '접근할 수 없는 주소예요';
  } catch { return '주소를 찾을 수 없어요'; }
  return undefined;
}

export async function assertUrlAllowed(raw: string, opts: SsrfOptions): Promise<void> {
  const why = await checkUrl(raw, opts);
  if (why) throw new ApiError(400, 'url_blocked', why);
}

/** 컨텍스트의 모든 요청(리다이렉트·하위 리소스 포함)을 검사하고 WebSocket을 막는다. */
export async function installGuards(context: BrowserContext, opts: SsrfOptions): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const why = await checkUrl(route.request().url(), opts).catch(() => 'blocked');
    if (why) await route.abort('blockedbyclient').catch(() => {});
    else await route.continue().catch(() => {});
  });
  await context.routeWebSocket(/.*/, (ws) => { void ws.close({ code: 1008, reason: 'blocked' }); });
}
