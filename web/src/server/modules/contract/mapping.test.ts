import { describe, expect, it } from 'vitest';
import { mapFields, type Candidate } from './mapping.js';

const c = (selector: string, text: string, o: Partial<Candidate> = {}): Candidate =>
  ({ selector, text, fontSize: 14, top: 0, left: 0, isLink: false, ...o });

describe('mapFields', () => {
  it('maps the demo row structure', () => {
    const f = mapFields([
      c('.company', '청솔소프트', { top: 0 }),
      c('h3', '백엔드 개발자', { fontSize: 20, top: 20 }),
      c('.exp', '경력 2~5년', { top: 50 }),
      c('.loc', '서울 강남구', { top: 50, left: 100 }),
      c('.type', '정규직', { top: 50, left: 200 }),
      c('.deadline', '2030-01-31', { top: 50, left: 300 }),
      c('a', '자세히', { isLink: true, href: 'http://x/1' }),
    ]);
    const m = Object.fromEntries(f.map((x) => [x.key, x]));
    expect(m.company!.selector).toBe('.company');
    expect(m.title!.selector).toBe('h3');
    expect(m.experience!.selector).toBe('.exp');
    expect(m.location!.selector).toBe('.loc');
    expect(m.employmentType!.selector).toBe('.type');
    expect(m.deadline!.selector).toBe('.deadline');
    expect(m.detailUrl).toMatchObject({ selector: 'a', value: 'attr:href', required: true });
  });
});
