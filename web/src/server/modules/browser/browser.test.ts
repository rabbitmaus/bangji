import { describe, expect, it } from 'vitest';
import { checkUrl, isBlockedHostname, isBlockedIp } from './ssrf.js';
import { buildSelector } from './region.js';

describe('ssrf', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254',
    '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
  it('classifies hostnames', () => {
    expect(isBlockedHostname('intranet')).toBe(true);
    expect(isBlockedHostname('web.internal.example.azurecontainerapps.io')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
  });
  it('validates URL shape and demo exception', async () => {
    const o = { allowDemo: false, demoOrigin: 'http://127.0.0.1:3000' };
    expect(await checkUrl('ftp://example.com/', o)).toBeTruthy();
    expect(await checkUrl('https://u:p@example.com/', o)).toBeTruthy();
    expect(await checkUrl('https://example.com:8443/', o)).toBeTruthy();
    expect(await checkUrl('http://127.0.0.1:3000/demo/jobs', o)).toBeTruthy();
    expect(await checkUrl('http://127.0.0.1:3000/demo/jobs', { ...o, allowDemo: true })).toBeUndefined();
  });
});

// 최소 DOM 모형
function node(tag: string, attrs: Record<string, string> = {}, parent?: any): any {
  const n: any = {
    nodeType: 1, tagName: tag.toUpperCase(), id: attrs.id ?? '', className: attrs.class ?? '', parentElement: parent, children: [],
    attributes: Object.entries(attrs).filter(([k]) => k !== 'id' && k !== 'class').map(([name, value]) => ({ name, value })),
  };
  parent?.children.push(n);
  return n;
}

describe('buildSelector', () => {
  it('prefers id and skips hash-like classes', () => {
    const body = node('body');
    const ul = node('ul', { class: 'css-1a2b3c jobs' }, body);
    const li = node('li', { class: 'sc-AxjAm' }, ul);
    const only = (s: string) => s === 'ul.jobs > li' || s === '#x';
    expect(buildSelector(li, { isUnique: only })).toBe('ul.jobs > li');
    const withId = node('div', { id: 'x' }, body);
    expect(buildSelector(withId, { isUnique: only })).toBe('#x');
  });
  it('falls back to nth-of-type path', () => {
    const body = node('body');
    node('p', {}, body);
    const p2 = node('p', {}, body);
    expect(buildSelector(p2, { isUnique: () => false })).toBe('body > p:nth-of-type(2)');
  });
});
