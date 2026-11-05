import { describe, expect, it } from 'vitest';
import { SseParser } from './sse.js';
import { mergeReplay, parseLastEventId } from './eventHub.js';

describe('SseParser', () => {
  it('handles chunk splits, CRLF, multi-line data, comments', () => {
    const p = new SseParser();
    const out = [
      ...p.push('id: r:1\r\nevent: verdict.final\r\ndata: {"a":'),
      ...p.push('1}\r\n\r\n: ping\n\nevent: x\ndata: a\ndata: b\n'),
      ...p.push('\n'),
    ];
    expect(out).toEqual([
      { id: 'r:1', event: 'verdict.final', data: '{"a":1}' },
      { id: undefined, event: 'x', data: 'a\nb' },
    ]);
  });
  it('flushes last unterminated event', () => {
    const p = new SseParser();
    expect(p.push('event: e\ndata: z')).toEqual([]);
    expect(p.flush()).toEqual([{ id: undefined, event: 'e', data: 'z' }]);
  });
});

describe('replay', () => {
  it('parses Last-Event-ID', () => {
    expect(parseLastEventId('erun_1:17')).toBe(17);
    expect(parseLastEventId(undefined)).toBe(0);
  });
  it('merges stored and memory events after lastSeq without delta or duplicates', () => {
    const ev = (seq: number, name = 'a') => ({ seq, name, data: {} });
    const r = mergeReplay([ev(1), ev(2), ev(3)], [ev(3), ev(4), ev(5, 'draft.delta')], 1);
    expect(r.map((e) => e.seq)).toEqual([2, 3, 4]);
  });
});
