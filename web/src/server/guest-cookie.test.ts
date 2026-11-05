import { describe, expect, it } from 'vitest';
import { newWorkspaceId, signValue, verifyValue } from './guest-cookie.js';
import { Limits } from './limits.js';
import { ApiError } from './context.js';

describe('guest cookie', () => {
  it('verifies signed values and rejects tampering', () => {
    const id = newWorkspaceId();
    const v = signValue(id, 's1');
    expect(verifyValue(v, 's1')).toBe(id);
    expect(verifyValue(v, 's2')).toBeUndefined();
    expect(verifyValue(signValue(newWorkspaceId(), 's1').replace(/.$/, 'x') , 's1')).toBeUndefined();
    expect(verifyValue(undefined, 's1')).toBeUndefined();
  });
});

describe('limits', () => {
  const cfg = { maxItems: 20, maxDetails: 10, runSeconds: 180, modelCalls: 40, runsPerHour: 2, guestsPerIpHour: 1, browserSessions: 1 };
  it('limits runs per hour with Retry-After and window expiry', () => {
    let t = 0;
    const l = new Limits(cfg, () => t);
    l.assertRunAllowed('a'); l.assertRunAllowed('a');
    try { l.assertRunAllowed('a'); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      expect((e as ApiError).headers['Retry-After']).toBe('3600');
    }
    l.assertRunAllowed('b');
    t = 3600_001;
    l.assertRunAllowed('a');
  });
  it('limits guests per ip and browser sessions', () => {
    const l = new Limits(cfg);
    l.assertGuestAllowed('1.1.1.1');
    expect(() => l.assertGuestAllowed('1.1.1.1')).toThrow(ApiError);
    l.assertBrowserSessionAllowed();
    expect(() => l.assertBrowserSessionAllowed()).toThrow(ApiError);
    l.releaseBrowserSession();
    l.assertBrowserSessionAllowed();
  });
});
