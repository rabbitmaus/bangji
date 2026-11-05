// 이력서 순수 로직: 연락처 마스킹, 문장 분리, sourceSpan 검증, 경력 연수 계산.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<!\d)(?:\+?82[-\s]?)?0?\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;

export function maskContacts(text: string): string {
  return text.replace(EMAIL, '[연락처]').replace(PHONE, (m) => {
    // 2022.03 ~ 2025.02 같은 연월 표기는 건드리지 않는다.
    const digits = m.replace(/\D/g, '');
    return digits.length >= 9 && (m.startsWith('0') || m.startsWith('+') || /[-\s]/.test(m)) && !/^(19|20)\d{2}[.\s-]\d{1,2}$/.test(m) ? '[연락처]' : m;
  });
}

export interface OriginalSentence { id: string; text: string }

export function splitSentences(text: string): OriginalSentence[] {
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // 숫자 사이의 마침표(2022.03)는 자르지 않는다.
    for (const s of t.split(/(?<=[.!?。])\s+(?=\S)/)) {
      if (s.trim()) parts.push(s.trim());
    }
  }
  return parts.map((text, i) => ({ id: `O${i + 1}`, text }));
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** sourceSpan이 원문에 실제로 있는지(공백·구두점 차이는 무시). */
export function verifySourceSpan(original: string, span: string | undefined): boolean {
  if (!span) return false;
  const n = normalize(span);
  return n.length >= 2 && normalize(original).includes(n);
}

export interface Period { start?: string; end?: string }

function toMonthIndex(ym: string | undefined, now: Date): number | undefined {
  if (!ym) return undefined;
  if (/present|현재|재직/i.test(ym)) return now.getUTCFullYear() * 12 + now.getUTCMonth();
  const m = ym.match(/^(\d{4})-(\d{1,2})$/);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : undefined;
}

/** experience 기간을 월 단위 구간으로 병합(겹침은 한 번만)해 연수(소수 1자리)로 계산한다. 시작·종료 월을 모두 포함한다. */
export function computeCareerYears(periods: Period[], now = new Date()): number {
  const ranges: [number, number][] = [];
  for (const p of periods) {
    const s = toMonthIndex(p.start, now);
    const e = toMonthIndex(p.end, now) ?? (p.end ? undefined : (s != null ? now.getUTCFullYear() * 12 + now.getUTCMonth() : undefined));
    if (s == null || e == null || e < s) continue;
    ranges.push([s, e]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cur: [number, number] | undefined;
  for (const r of ranges) {
    if (cur && r[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], r[1]);
    else { if (cur) months += cur[1] - cur[0] + 1; cur = [...r]; }
  }
  if (cur) months += cur[1] - cur[0] + 1;
  return Math.round((months / 12) * 10) / 10;
}
