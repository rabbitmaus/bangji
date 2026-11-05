// 노드별 순수 변환 로직. 사용자 코드는 실행하지 않고 카탈로그에 있는 설정만 해석한다.
export interface WfVerdict {
  decision: 'pass' | 'hold' | 'reject';
  holdReasons: string[];
  criteria: unknown[];
}

export interface WfItem {
  itemKey: string;
  fields: Record<string, string | null>;
  injectionSuspected: boolean;
  detailMissing: boolean;
  detailBlob?: string;
  verdict?: WfVerdict;
  sources?: string[];
}

export interface WfArtifact {
  kind: 'tailor' | 'markdown' | 'list';
  title: string;
  markdown?: string;
  entries?: Record<string, unknown>[];
  sample: boolean;
}

export type PortPayload = WfItem[] | WfArtifact;
export type NodeOutputs = Record<string, PortPayload>;

export const isItems = (p: PortPayload | undefined): p is WfItem[] => Array.isArray(p);
export const isArtifact = (p: PortPayload | undefined): p is WfArtifact => !!p && !Array.isArray(p);

const PREVIEW_FIELDS = ['title', 'company', 'location', 'deadline', 'employmentType', 'experience'];
export const clip = (v: unknown, n = 80): string => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// 이벤트·상태에 싣는 미리보기. 허용 필드만 잘라서 담고 이력서 내용은 넣지 않는다.
export function previewItems(items: WfItem[], max = 3): Record<string, unknown>[] {
  return items.slice(0, max).map((it) => {
    const row: Record<string, unknown> = { itemId: it.itemKey };
    for (const k of PREVIEW_FIELDS) if (it.fields[k]) row[k] = clip(it.fields[k]);
    if (it.verdict) { row.decision = it.verdict.decision; if (it.verdict.holdReasons.length) row.holdReasons = it.verdict.holdReasons.slice(0, 3); }
    return row;
  });
}

export function previewArtifact(a: WfArtifact): Record<string, unknown>[] {
  return [{ kind: a.kind, title: clip(a.title), entries: a.entries?.length ?? 0, chars: a.markdown?.length ?? 0, sample: a.sample }];
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}
const norm = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const urlOf = (it: WfItem) => it.fields.detailUrl || it.fields.url || '';

function dedupeKey(it: WfItem, keyFields: string[]): string {
  const parts = keyFields.map((k) => (k === 'url' ? (urlOf(it) ? normalizeUrl(urlOf(it)) : '') : norm(it.fields[k])));
  if (parts.some(Boolean)) return parts.join('|');
  return `${norm(it.fields.company)}|${norm(it.fields.title)}`;
}

export function mergeDedupe(groups: WfItem[][], keyFields: string[], max: number): WfItem[] {
  const seen = new Map<string, WfItem>();
  const ids = new Set<string>();
  for (const g of groups) {
    for (const it of g) {
      const k = dedupeKey(it, keyFields);
      const prev = seen.get(k);
      if (prev) { prev.sources = [...new Set([...(prev.sources ?? []), ...(it.sources ?? [])])]; continue; }
      let itemKey = it.itemKey;
      for (let n = 2; ids.has(itemKey); n++) itemKey = `${it.itemKey}~${n}`;
      ids.add(itemKey);
      seen.set(k, { ...it, itemKey });
    }
  }
  return [...seen.values()].slice(0, max);
}

const toIso = (v: string): string | undefined => {
  const m = v.match(/(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : undefined;
};

export function normalizeFields(items: WfItem[], cfg: { renames?: Record<string, string>; dateFormat?: 'iso' | 'ymd' }): WfItem[] {
  const renames = cfg.renames ?? {};
  return items.map((it) => {
    const fields: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(it.fields)) {
      let val = v;
      if (cfg.dateFormat && val && /date|deadline|마감|기간/i.test(k)) {
        const iso = toIso(val);
        if (iso) val = cfg.dateFormat === 'iso' ? iso : iso.replace(/-/g, '.');
      }
      fields[renames[k] ?? k] = val;
    }
    return { ...it, fields };
  });
}

export interface RuleCfg {
  criterion: 'deadline' | 'experience' | 'region' | 'employment';
  required?: boolean;
  params?: { minYears?: number; maxYears?: number; allowedRegions?: string[]; allowRemote?: boolean; employmentTypes?: string[]; notPast?: boolean };
}

// 값을 알 수 없으면 거르지 않고 다음 단계(근거 평가)로 넘긴다.
function ruleFails(it: WfItem, r: RuleCfg, today: string): boolean {
  const p = r.params ?? {};
  const f = it.fields;
  if (r.criterion === 'deadline') {
    const d = f.deadline ? toIso(f.deadline) : undefined;
    return !!(p.notPast !== false && d && d < today);
  }
  if (r.criterion === 'experience') {
    const text = f.experience ?? '';
    const nums = (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (!nums.length) return false;
    const lo = Math.min(...nums);
    const hi = nums.length > 1 ? Math.max(...nums) : undefined;
    if (typeof p.maxYears === 'number' && lo > p.maxYears) return true;
    return typeof p.minYears === 'number' && hi !== undefined && hi < p.minYears;
  }
  if (r.criterion === 'region') {
    const loc = f.location ?? '';
    const allowed = p.allowedRegions ?? [];
    if (!loc || !allowed.length) return false;
    if (p.allowRemote && /재택|원격|remote/i.test(loc)) return false;
    return !allowed.some((a) => loc.includes(a));
  }
  const emp = f.employmentType ?? f.employment ?? '';
  const types = p.employmentTypes ?? [];
  return !!emp && types.length > 0 && !types.some((t) => emp.includes(t));
}

export function ruleFilter(items: WfItem[], rules: RuleCfg[], now = new Date()): { kept: WfItem[]; dropped: number } {
  const today = now.toISOString().slice(0, 10);
  const active = rules.filter((r) => r.required !== false);
  const kept = items.filter((it) => !active.some((r) => ruleFails(it, r, today)));
  return { kept, dropped: items.length - kept.length };
}

export function branch(items: WfItem[], cfg: { on?: string; field?: string; equals?: unknown }): { t: WfItem[]; f: WfItem[] } {
  const want = String(cfg.equals ?? 'pass').toLowerCase();
  const t: WfItem[] = [];
  const f: WfItem[] = [];
  for (const it of items) {
    const v = cfg.on === 'field' && cfg.field ? it.fields[cfg.field] : it.verdict?.decision;
    (String(v ?? '').toLowerCase() === want ? t : f).push(it);
  }
  return { t, f };
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length >= 2));

// 확인된 이력서 사실 중 공고와 겹치는 것을 고른다. 새 문장을 만들지 않으므로 사실을 지어낼 수 없다.
export function tailorSuggestions(items: WfItem[], facts: { id?: unknown; text?: unknown; skills?: unknown }[], maxPerItem: number): Record<string, unknown>[] {
  return items.map((it) => {
    const jobWords = words(Object.values(it.fields).filter(Boolean).join(' '));
    const scored = facts.map((f) => {
      const fw = words(`${String(f.text ?? '')} ${Array.isArray(f.skills) ? f.skills.join(' ') : ''}`);
      let score = 0;
      for (const w of fw) if (jobWords.has(w)) score++;
      return { f, score };
    }).sort((a, b) => b.score - a.score);
    const picked = scored.filter((s) => s.score > 0).slice(0, maxPerItem);
    return {
      itemKey: it.itemKey, title: it.fields.title ?? '', company: it.fields.company ?? '', url: urlOf(it) || undefined,
      matchedFacts: picked.map((s) => ({ factId: String(s.f.id ?? ''), text: String(s.f.text ?? ''), score: s.score })),
    };
  });
}

const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const SAMPLE_NOTE = '> 샘플 실행 결과예요. 일부 항목만 처리했고 실제 사용 전에 전체 실행이 필요해요.\n\n';
export const MAX_MARKDOWN = 100_000;

export function renderTailorMarkdown(title: string, entries: Record<string, unknown>[], sample: boolean): string {
  const lines = [`# ${title}`, ''];
  if (sample) lines.push(SAMPLE_NOTE.trim(), '');
  for (const e of entries) {
    lines.push(`## ${cell(e.company)} — ${cell(e.title)}`);
    if (e.url) lines.push(String(e.url));
    const facts = (e.matchedFacts as { text: string }[]) ?? [];
    if (!facts.length) lines.push('', '- 겹치는 이력서 사실을 찾지 못했어요');
    for (const f of facts) lines.push('', `- ${f.text}`);
    lines.push('');
  }
  return lines.join('\n').slice(0, MAX_MARKDOWN);
}

export function renderList(title: string, items: WfItem[], sample: boolean): { markdown: string; entries: Record<string, unknown>[] } {
  const entries = items.map((it) => ({
    itemKey: it.itemKey, title: it.fields.title ?? '', company: it.fields.company ?? '', url: urlOf(it) || undefined,
    decision: it.verdict?.decision, reasons: it.verdict?.holdReasons ?? [],
  }));
  const head = `# ${title}\n\n${sample ? SAMPLE_NOTE : ''}| 회사 | 공고 | 판정 | 이유 |\n| --- | --- | --- | --- |\n`;
  const rows = entries.map((e) => `| ${cell(e.company)} | ${e.url ? `[${cell(e.title)}](${e.url})` : cell(e.title)} | ${e.decision ?? '-'} | ${cell((e.reasons as string[]).join(', '))} |`);
  return { markdown: (head + rows.join('\n')).slice(0, MAX_MARKDOWN), entries };
}
