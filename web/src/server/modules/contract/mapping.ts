// TRD 5.4 필드 자동 매핑 (순수 함수)
import type { FieldKey } from './schema.js';

export interface Candidate {
  selector: string;      // 항목 기준 selector
  text: string;
  href?: string;
  fontSize: number;
  top: number;
  left: number;
  isLink: boolean;
}
export interface MappedField { key: FieldKey; selector: string; value: 'text' | 'attr:href'; required: boolean }

const REGIONS = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '성남', '판교', '강남', '원격', '재택'];
const EMPLOYMENT = ['정규직', '계약직', '인턴', '파견직', '프리랜서', '아르바이트', '병역특례'];
const DATE_RE = /(\d{4}[-./]\d{1,2}[-./]\d{1,2})|(\d{1,2}\s*[월/.]\s*\d{1,2}\s*일?)|D-\d+|상시|마감/;
const EXP_RE = /(\d+\s*[~\-–]\s*\d+\s*년)|(\d+\s*년\s*(이상|이하|차)?)|신입|경력/;

export const isDate = (t: string) => DATE_RE.test(t);
export const isExperience = (t: string) => EXP_RE.test(t) && !isDate(t);
export const isLocation = (t: string) => REGIONS.some((r) => t.includes(r));
export const isEmployment = (t: string) => EMPLOYMENT.some((r) => t.includes(r));

const sizeOk = (t: string) => t.length > 0 && t.length <= 120;

export function mapFields(cands: Candidate[]): MappedField[] {
  const used = new Set<Candidate>();
  const out: MappedField[] = [];
  const take = (key: FieldKey, pred: (c: Candidate) => boolean, required = false) => {
    const c = cands.find((x) => !used.has(x) && sizeOk(x.text) && pred(x));
    if (!c) return;
    used.add(c);
    out.push({ key, selector: c.selector, value: 'text', required });
  };

  const link = cands.find((c) => c.isLink && c.href);
  take('deadline', (c) => isDate(c.text) && !c.isLink);
  take('employmentType', (c) => isEmployment(c.text) && c.text.length <= 20);
  take('experience', (c) => isExperience(c.text) && c.text.length <= 30);
  take('location', (c) => isLocation(c.text) && c.text.length <= 30);

  // 회사·직무: 남은 텍스트 중 글자 크기가 큰 쪽이 직무, 위치가 먼저인 쪽이 회사
  const rest = cands.filter((c) => !used.has(c) && !c.isLink && sizeOk(c.text) && c.text.length >= 2);
  if (rest.length) {
    const title = [...rest].sort((a, b) => b.fontSize - a.fontSize || a.top - b.top)[0]!;
    used.add(title);
    const company = rest.filter((c) => c !== title).sort((a, b) => a.top - b.top || a.left - b.left)[0];
    if (company) { used.add(company); out.push({ key: 'company', selector: company.selector, value: 'text', required: true }); }
    out.push({ key: 'title', selector: title.selector, value: 'text', required: true });
  }
  if (link) out.push({ key: 'detailUrl', selector: link.selector, value: 'attr:href', required: true });

  const order = ['company', 'title', 'experience', 'location', 'employmentType', 'deadline', 'detailUrl'];
  return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
