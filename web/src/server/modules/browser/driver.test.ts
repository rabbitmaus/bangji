import { describe, expect, it, vi } from 'vitest';

const close = vi.fn(async () => {});
const launch = vi.fn(async (_o: unknown) => ({
  sessionId: 's1',
  context: { pages: async () => [{ goto: async () => ({ status: () => 403 }) }] },
  close,
}));
vi.mock('@browserbasehq/stagehand', () => ({
  browserbase: { launch },
  Stagehand: { create: async () => ({ close: async () => {} }) },
}));

const { selectProvider, openBrowserbaseDriver, toSource } = await import('./driver.js');

describe('driver selection', () => {
  it('demo is always local; custom uses Browserbase only with a key', () => {
    expect(selectProvider('demo', { browserbaseApiKey: 'k' })).toBe('local');
    expect(selectProvider('custom', { browserbaseApiKey: 'k' })).toBe('browserbase');
    expect(selectProvider('custom', {})).toBe('local');
  });
  it('launches Browserbase with 1280x800 viewport and maps 403 to page_blocked', async () => {
    const d = await openBrowserbaseDriver('k');
    expect(launch.mock.calls[0]![0]).toMatchObject({ apiKey: 'k', browserSettings: { viewport: { width: 1280, height: 800 } } });
    await expect(d.goto('https://example.com')).rejects.toMatchObject({ code: 'page_blocked' });
    await d.close();
    expect(close).toHaveBeenCalled();
  });
  it('serializes functions with args', () => {
    expect(toSource((a: number) => a + 1, 2)).toContain('(2)');
  });
});
