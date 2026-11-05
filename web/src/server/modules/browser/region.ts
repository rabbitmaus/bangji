// 페이지 안에서 실행되는 순수 DOM 함수들. 각 함수는 자기완결적이어야 한다(외부 식별자 참조 금지):
// page.evaluate로 소스를 직렬화해 넘기기 때문이다.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BuildSelectorOptions {
  /** selector가 문서에서 유일한지 판정. 기본값은 ownerDocument.querySelectorAll. */
  isUnique?: (selector: string) => boolean;
  maxDepth?: number;
}

/** 안정 속성(id, data-*, aria-*, role, 의미 있는 class) 우선, 해시 class 제외, 깊이 ≤ 4, 유일성 확인. */
export function buildSelector(el: any, opts: BuildSelectorOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 4;
  const isUnique = opts.isUnique ?? ((s: string) => {
    try { return el.ownerDocument.querySelectorAll(s).length === 1; } catch { return false; }
  });
  const esc = (v: string) => String(v).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const isHashy = (c: string) =>
    /^(css|sc|jsx|styled|emotion|tw)-/i.test(c) || /\d{3,}/.test(c) || /[0-9a-f]{6,}/i.test(c) && /\d/.test(c) ||
    /__[A-Za-z0-9_-]{5,}$/.test(c) && /\d|[A-Z]/.test(c.split('__').pop() ?? '') ||
    (c.length >= 6 && /^[A-Za-z0-9]+$/.test(c) && /[a-z]/.test(c) && /[A-Z]/.test(c) && /\d/.test(c));
  const stableAttrs = (n: any): string[] => {
    const out: string[] = [];
    const attrs: any[] = Array.from(n.attributes ?? []);
    for (const a of attrs) {
      const name = String(a.name);
      if (name === 'role' && a.value) out.push(`[role="${esc(a.value)}"]`);
      else if ((name.startsWith('data-') || name.startsWith('aria-')) && a.value && a.value.length <= 40 &&
        !/data-(reactid|react|v-|testid-hash)/.test(name) && !/\d{4,}/.test(a.value)) out.push(`[${name}="${String(a.value).replace(/"/g, '\\"')}"]`);
    }
    return out;
  };
  const classesOf = (n: any): string[] => {
    const raw = typeof n.className === 'string' ? n.className : (n.getAttribute?.('class') ?? '');
    return String(raw).split(/\s+/).filter((c) => c && !isHashy(c) && /^[A-Za-z_-][\w-]*$/.test(c));
  };
  const nth = (n: any): string => {
    const p = n.parentElement;
    if (!p) return '';
    const same = Array.from(p.children as ArrayLike<any>).filter((c: any) => c.tagName === n.tagName);
    return same.length > 1 ? `:nth-of-type(${same.indexOf(n) + 1})` : '';
  };
  // 한 노드의 후보 조각들(구체성 오름차순)
  const candidates = (n: any): string[] => {
    const tag = String(n.tagName).toLowerCase();
    const res: string[] = [];
    if (n.id && !isHashy(n.id) && /^[A-Za-z][\w-]*$/.test(n.id)) res.push(`#${esc(n.id)}`);
    const attrs = stableAttrs(n);
    const cls = classesOf(n);
    for (const a of attrs) res.push(`${tag}${a}`);
    if (cls.length) { res.push(`${tag}.${esc(cls[0])}`); if (cls.length > 1) res.push(`${tag}.${cls.slice(0, 2).map(esc).join('.')}`); }
    res.push(tag);
    return res;
  };

  const chain: any[] = [];
  for (let n = el; n && n.nodeType === 1 && chain.length < maxDepth; n = n.parentElement) {
    chain.push(n);
    if (String(n.tagName).toLowerCase() === 'body') break;
  }
  // 자기 자신의 조각 하나로 시작해 조상을 하나씩 붙여 가며 유일해지는 가장 짧은 selector를 찾는다.
  const own = candidates(el);
  for (let depth = 1; depth <= chain.length; depth++) {
    const ancestors = chain.slice(1, depth).map((a: any) => candidates(a)[0]).reverse();
    for (const piece of own) {
      const sel = [...ancestors, piece].join(' > ').replace(/^body > /, '');
      if (isUnique(sel)) return sel;
    }
  }
  // 마지막 수단: 태그 + nth-of-type 경로
  const path: string[] = [];
  for (const n of chain.slice().reverse()) path.push(String(n.tagName).toLowerCase() + nth(n));
  return path.join(' > ');
}

export interface ScoredCandidate {
  /** start에서 시작하는 조상 사슬의 인덱스(0 = start 자신), descendants 모드에서는 순번 */
  index: number;
  selector: string;
  tag: string;
  itemCount: number;
  similarity: number;
  score: number;
  rect: { x: number; y: number; width: number; height: number };
  sampleText: string;
}

export interface ScoreOptions {
  mode?: 'ancestors' | 'descendants';
  maxChain?: number;
  /** 컨테이너 selector 생성기(보통 buildSelector). 없으면 빈 문자열. */
  selectorFn?: (el: any) => string;
}

/**
 * 반복 구조 점수. 'ancestors': start부터 body 직전까지의 조상 사슬 각각을 채점.
 * 'descendants': start(문서 루트) 아래 모든 컨테이너를 채점. 점수 내림차순이 아니라 사슬 순서(ancestors) 또는 점수 내림차순(descendants)으로 반환.
 * 점수 = log2(같은 서명 자식 수 + 1) × 구조 유사도 × (0.3 + 0.7·√화면 점유율)
 */
export function scoreRepeatingAncestors(start: any, opts: ScoreOptions = {}): ScoredCandidate[] {
  const doc = start.ownerDocument ?? start;
  const win = doc.defaultView;
  const vw = win?.innerWidth || 1280;
  const vh = win?.innerHeight || 800;
  const isHashy = (c: string) => /\d{3,}/.test(c) || /^(css|sc|jsx)-/i.test(c) || /[0-9a-f]{6,}/i.test(c) && /\d/.test(c);
  const sig = (n: any) => {
    const raw = typeof n.className === 'string' ? n.className : '';
    const cls = raw.split(/\s+/).filter((c: string) => c && !isHashy(c)).sort().join('.');
    return String(n.tagName).toLowerCase() + (cls ? '.' + cls : '');
  };
  const tagSet = (n: any): Set<string> => {
    const s = new Set<string>();
    const all: any[] = Array.from(n.querySelectorAll('*')).slice(0, 40) as any[];
    for (const d of all) s.add(String(d.tagName).toLowerCase());
    return s;
  };
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    a.forEach((x) => { if (b.has(x)) inter++; });
    return inter / (a.size + b.size - inter);
  };
  const skipTags = new Set(['script', 'style', 'option', 'br', 'hr', 'noscript', 'svg', 'path']);
  const scoreOne = (container: any, index: number): ScoredCandidate | undefined => {
    const kids: any[] = (Array.from(container.children) as any[]).filter((k) => !skipTags.has(String(k.tagName).toLowerCase()));
    if (kids.length < 2) return undefined;
    const groups = new Map<string, any[]>();
    for (const k of kids) { const s = sig(k); (groups.get(s) ?? groups.set(s, []).get(s)!).push(k); }
    let best: any[] = [];
    groups.forEach((g) => { if (g.length > best.length) best = g; });
    if (best.length < 2) return undefined;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return undefined;
    const base = tagSet(best[0]);
    const sim = best.reduce((acc: number, k: any) => acc + jaccard(base, tagSet(k)), 0) / best.length;
    const ratio = Math.min(1, (rect.width * rect.height) / (vw * vh));
    const avgText = best.reduce((a: number, k: any) => a + String(k.textContent ?? '').trim().length, 0) / best.length;
    let score = Math.log2(best.length + 1) * sim * (0.3 + 0.7 * Math.sqrt(ratio));
    if (avgText < 10) score *= 0.3;
    if (container.closest?.('nav, header, footer')) score *= 0.5;
    return {
      index, selector: '', tag: String(container.tagName).toLowerCase(), itemCount: best.length,
      similarity: Math.round(sim * 1000) / 1000, score: Math.round(score * 1000) / 1000,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      sampleText: String(best[0].textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  };

  const out: ScoredCandidate[] = [];
  const selectorOf = (n: any) => opts.selectorFn ? opts.selectorFn(n) : '';
  if ((opts.mode ?? 'ancestors') === 'ancestors') {
    const max = opts.maxChain ?? 12;
    let i = 0;
    for (let n = start; n && n.nodeType === 1 && out.length < max; n = n.parentElement, i++) {
      const t = String(n.tagName).toLowerCase();
      if (t === 'body' || t === 'html') break;
      const c = scoreOne(n, i);
      if (c) { c.selector = selectorOf(n); out.push(c); }
    }
  } else {
    const all: any[] = [start, ...(Array.from(start.querySelectorAll('*')) as any[])];
    let i = 0;
    for (const n of all) {
      const t = String(n.tagName).toLowerCase();
      if (t === 'html' || t === 'body' || skipTags.has(t)) continue;
      const c = scoreOne(n, i++);
      if (c && c.itemCount >= 3) { c.selector = selectorOf(n); out.push(c); }
    }
    out.sort((a, b) => b.score - a.score);
  }
  return out;
}
