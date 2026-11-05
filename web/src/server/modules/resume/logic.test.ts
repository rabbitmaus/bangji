import { describe, expect, it } from 'vitest';
import { computeCareerYears, maskContacts, verifySourceSpan } from './logic.js';

describe('maskContacts', () => {
  it('masks phone and email but not periods', () => {
    const out = maskContacts('a@b.com 010-1234-5678 가상회사A 2022.03 ~ 2025.02');
    expect(out).toBe('[연락처] [연락처] 가상회사A 2022.03 ~ 2025.02');
  });
});

describe('computeCareerYears', () => {
  it('merges overlapping periods once', () => {
    const y = computeCareerYears([{ start: '2020-01', end: '2020-12' }, { start: '2020-07', end: '2021-12' }]);
    expect(y).toBe(2);
  });
  it('sums separate periods', () => {
    expect(computeCareerYears([{ start: '2020-01', end: '2020-06' }, { start: '2021-01', end: '2021-06' }])).toBe(1);
  });
});

describe('verifySourceSpan', () => {
  const orig = '가상회사A | 백엔드 개발자 | 2022.03 ~ 2025.02';
  it('accepts spans present modulo punctuation', () => {
    expect(verifySourceSpan(orig, '가상회사A 백엔드 개발자 2022.03~2025.02')).toBe(true);
  });
  it('rejects absent spans', () => {
    expect(verifySourceSpan(orig, '구글 시니어 엔지니어')).toBe(false);
  });
});
