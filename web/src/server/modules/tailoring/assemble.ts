export interface Original { id: string; text: string; section?: string }
export interface Sentence {
  sentenceId: string; section?: string; text: string; sourceFactIds: string[]; requirementIds: string[];
  changeType: 'kept' | 'reordered' | 'rephrased' | 'summarized'; originalRefs: string[];
  status?: 'verified' | 'unsupported' | 'pending'; reasons?: string[];
}
export type ChangeKind = 'modified' | 'added' | 'removed' | 'reordered';
// 평가기 compare.py의 변경 목록과 같은 모양·같은 ID(C-S1, C-O3).
export interface Change {
  changeId: string; kind: ChangeKind; sentenceId?: string; originalRefs: string[];
  before?: string; after?: string; status?: 'verified' | 'unsupported' | 'pending'; reasons: string[]; requiresDecision: boolean;
}
export type Decisions = Record<string, 'accept' | 'reject'>;

const sortKey = (ref: string) => Number(ref.replace(/\D/g, '')) || 0;

// compare.py build_changes 이식. kept는 변경이 아니고 reordered는 결정을 받지 않는다.
export function buildChanges(originals: Original[], sentences: Sentence[]): Change[] {
  const orig = new Map(originals.map((o) => [o.id, o]));
  const changes: Change[] = [];
  const referenced = new Set<string>();
  for (const s of sentences) {
    for (const r of s.originalRefs ?? []) referenced.add(r);
    const refs = s.originalRefs ?? [];
    const before = refs.map((r) => orig.get(r)?.text).filter((t): t is string => !!t).join('\n') || undefined;
    const base = { changeId: `C-${s.sentenceId}`, sentenceId: s.sentenceId, after: s.text, status: s.status, reasons: s.reasons ?? [] };
    if (!refs.length) changes.push({ ...base, kind: 'added', originalRefs: [], requiresDecision: true });
    else if (s.changeType === 'reordered') changes.push({ ...base, kind: 'reordered', originalRefs: refs, before, requiresDecision: false });
    else if (s.changeType !== 'kept' && (before ?? '').trim() !== s.text.trim()) changes.push({ ...base, kind: 'modified', originalRefs: refs, before, requiresDecision: true });
  }
  for (const o of originals) {
    if (!referenced.has(o.id)) changes.push({ changeId: `C-${o.id}`, kind: 'removed', originalRefs: [o.id], before: o.text, reasons: [], requiresDecision: true });
  }
  return changes;
}

// compare.py assemble_items 이식. 결정하지 않은 변경은 거절이고, verified가 아닌 문장은 수락해도 쓰지 않는다.
export function assemble(originals: Original[], sentences: Sentence[], decisions: Decisions): { section: string; text: string }[] {
  const orig = new Map(originals.map((o) => [o.id, o]));
  const changes = new Map(buildChanges(originals, sentences).map((c) => [c.changeId, c]));
  const out: { pos: number | null; section: string; text: string }[] = [];
  const used = new Set<string>();
  const idx = (refs: string[]) => (refs.length ? Math.min(...refs.map(sortKey)) : null);
  const pushOrig = (r: string, fallback: string) => {
    const o = orig.get(r);
    if (o && !used.has(r)) { used.add(r); out.push({ pos: sortKey(r), section: o.section ?? fallback, text: o.text }); }
  };

  for (const s of sentences) {
    const verified = s.status === 'verified';
    const refs = s.originalRefs ?? [];
    const section = s.section ?? 'summary';
    const cid = `C-${s.sentenceId}`;
    const ch = changes.get(cid);
    if (!ch) {
      const known = refs.filter((r) => orig.has(r));
      if (known.length) known.forEach((r) => pushOrig(r, section));
      else if (verified) out.push({ pos: null, section, text: s.text });
      continue;
    }
    if (ch.kind === 'reordered') {
      if (verified) out.push({ pos: idx(refs), section, text: s.text });
      else refs.forEach((r) => pushOrig(r, section));
      continue;
    }
    if (decisions[cid] === 'accept' && verified) {
      refs.forEach((r) => used.add(r));
      out.push({ pos: idx(refs), section, text: s.text });
    } else if (ch.kind === 'modified') refs.forEach((r) => pushOrig(r, section));
  }
  for (const o of originals) {
    const ch = changes.get(`C-${o.id}`);
    if (ch?.kind === 'removed' && decisions[ch.changeId] !== 'accept' && !used.has(o.id)) {
      used.add(o.id);
      const pos = sortKey(o.id);
      let at = out.findIndex((e) => e.pos !== null && e.pos > pos);
      if (at < 0) at = out.length;
      out.splice(at, 0, { pos, section: o.section ?? 'experience', text: o.text });
    }
  }
  return out.map(({ section, text }) => ({ section, text }));
}

const SECTION_TITLES: Record<string, string> = { summary: '요약', experience: '경력', project: '프로젝트', skill: '기술', skills: '기술', education: '학력', certification: '자격증', etc: '기타' };

export function renderMarkdown(head: { title: string; company: string; url?: string; generatedAt: string }, lines: { section: string; text: string }[]): string {
  const parts = [
    `# 맞춤 이력서 초안 — ${head.company} ${head.title}`.trim(),
    '',
    '> AI가 작성하고 사용자가 확인한 맞춤 이력서 초안입니다.',
    '',
    `- 공고: ${head.title}`,
    `- 회사: ${head.company}`,
    head.url ? `- 공고 URL: ${head.url}` : '- 공고 URL: (없음)',
    `- 생성 시각: ${head.generatedAt}`,
    '',
  ];
  const order: string[] = [];
  for (const l of lines) if (!order.includes(l.section)) order.push(l.section);
  for (const sec of order) {
    parts.push(`## ${SECTION_TITLES[sec] ?? sec}`, '');
    for (const l of lines.filter((x) => x.section === sec)) parts.push(`- ${l.text}`);
    parts.push('');
  }
  return parts.join('\n');
}
