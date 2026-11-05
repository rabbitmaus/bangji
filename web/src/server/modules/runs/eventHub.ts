import type { Request, Response } from 'express';
import type { DocStore, Doc } from '../../context.js';
import { formatSse, openSse } from './sse.js';

export interface StoredEvent { seq: number; name: string; data: Record<string, unknown> }

const NO_PERSIST = new Set(['draft.delta', 'assistant.delta', 'heartbeat']);
const MEM_CAP = 3000;

export function parseLastEventId(id: string | undefined | null): number {
  if (!id) return 0;
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 저장소와 메모리 로그를 합쳐 lastSeq 이후 이벤트를 seq 오름차순·중복 없이 돌려준다.
export function mergeReplay(stored: StoredEvent[], mem: StoredEvent[], lastSeq: number): StoredEvent[] {
  const bySeq = new Map<number, StoredEvent>();
  for (const e of [...stored, ...mem]) {
    if (e.seq > lastSeq && !NO_PERSIST.has(e.name)) bySeq.set(e.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

interface Channel {
  seq: number;
  log: StoredEvent[];
  listeners: Set<(e: StoredEvent) => void>;
  ready: Promise<void>;
  closed: boolean;
}

export class EventHub {
  private channels = new Map<string, Channel>();
  constructor(private store: DocStore) {}

  private channel(workspaceId: string, id: string): Channel {
    let ch = this.channels.get(id);
    if (!ch) {
      const c: Channel = { seq: 0, log: [], listeners: new Set(), closed: false, ready: Promise.resolve() };
      c.ready = this.store.list<Doc & { seq?: number }>(workspaceId, 'event', `event:${id}:`).then(
        (docs) => { for (const d of docs) c.seq = Math.max(c.seq, Number(d.seq) || 0); },
        () => undefined,
      );
      this.channels.set(id, c);
      ch = c;
    }
    return ch;
  }

  isActive(id: string): boolean { const c = this.channels.get(id); return !!c && !c.closed; }

  async emit(workspaceId: string, id: string, name: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    const ch = this.channel(workspaceId, id);
    ch.closed = false;
    await ch.ready;
    const seq = ++ch.seq;
    const ev: StoredEvent = { seq, name, data: { ...data, runId: id, seq } };
    const persist = !NO_PERSIST.has(name);
    if (persist) {
      ch.log.push(ev);
      if (ch.log.length > MEM_CAP) ch.log.shift();
    }
    for (const l of ch.listeners) { try { l(ev); } catch { /* 끊긴 구독자 무시 */ } }
    if (persist) {
      await this.store.upsert({
        id: `event:${id}:${seq}`, type: 'event', workspaceId, runId: id, seq, name, data: ev.data, ttl: 604800,
      } as Doc).catch(() => undefined);
    }
    return ev;
  }

  close(id: string): void {
    const ch = this.channels.get(id);
    if (ch) ch.closed = true;
  }

  // Last-Event-ID 재전송 후 실시간 이벤트를 이어 보낸다. 종료 이벤트가 나오면 스트림을 닫는다.
  async serve(req: Request, res: Response, workspaceId: string, id: string, opts: {
    terminalNames: string[]; alreadyFinished: () => Promise<boolean>; heartbeatMs?: number;
  }): Promise<void> {
    const lastSeq = parseLastEventId(req.header('Last-Event-ID') ?? (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined));
    openSse(res);
    const ch = this.channel(workspaceId, id);
    await ch.ready;
    const buffered: StoredEvent[] = [];
    let replaying = true;
    let sentSeq = lastSeq;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const end = () => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      ch.listeners.delete(listener);
      res.end();
    };
    const write = (e: StoredEvent) => {
      if (e.seq <= sentSeq) return;
      sentSeq = e.seq;
      res.write(formatSse({ id: `${id}:${e.seq}`, event: e.name, data: e.data }));
      if (opts.terminalNames.includes(e.name)) end();
    };
    const listener = (e: StoredEvent) => {
      if (finished) return;
      if (replaying) buffered.push(e);
      else if (NO_PERSIST.has(e.name)) res.write(formatSse({ event: e.name, data: e.data }));
      else write(e);
    };
    ch.listeners.add(listener);
    req.on('close', () => { finished = true; if (timer) clearInterval(timer); ch.listeners.delete(listener); });

    const stored = await this.store.list<Doc & StoredEvent>(workspaceId, 'event', `event:${id}:`).catch(() => []);
    const replay = mergeReplay(
      stored.map((d) => ({ seq: Number(d.seq), name: String(d.name), data: (d.data ?? {}) as Record<string, unknown> })),
      ch.log, lastSeq,
    );
    for (const e of replay) { if (finished) return; write(e); }
    replaying = false;
    for (const e of buffered) {
      if (finished) return;
      if (NO_PERSIST.has(e.name)) res.write(formatSse({ event: e.name, data: e.data })); else write(e);
    }
    if (finished) return;
    if (!this.isActive(id) || (await opts.alreadyFinished())) return end();

    timer = setInterval(() => {
      if (!finished) res.write(formatSse({ event: 'heartbeat', data: {} }));
    }, opts.heartbeatMs ?? 15_000);
    timer.unref?.();
  }
}
