import type { PageDriver } from '../browser/driver.js';
import { ApiError } from '../../context.js';
import type { Candidate } from './mapping.js';

type Evaluator = Pick<PageDriver, 'evaluate'>;

export interface ItemProbe { count: number; candidates: Candidate[] }

// 컨테이너 안의 항목 selector(없으면 반복 구조 추정)와 첫 항목의 후보 요소를 구한다.
export async function probeContainer(page: Evaluator, container: string, itemSel?: string): Promise<{ item: string; probe: ItemProbe }> {
  const res = await page.evaluate(({ container, itemSel }) => {
    const root = document.querySelector(container);
    if (!root) return null;
    const stable = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (el.id && !/\d{3,}|[a-f0-9]{8,}/i.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
      for (const a of Array.from(el.attributes)) {
        if (a.name.startsWith('data-') && a.value && a.value.length < 30) return `${tag}[${a.name}='${a.value}']`;
      }
      const cls = Array.from(el.classList).find((c) => c.length > 1 && c.length < 24 && !/^[a-z]{0,3}[A-Za-z0-9_-]*\d{3,}|^[a-zA-Z0-9]{8,}$/.test(c) && !/^(css|sc|jsx|_)-/.test(c) && !/[A-Z].*[0-9]|[0-9].*[A-Z]/.test(c));
      if (cls) return `${tag}.${CSS.escape(cls)}`;
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((x) => x.tagName === el.tagName);
        if (same.length > 1) return `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
      }
      return tag;
    };
    let item = itemSel;
    if (!item) {
      const kids = Array.from(root.children);
      const tag = kids[0]?.tagName.toLowerCase();
      item = tag ? `:scope > ${tag}` : ':scope > *';
    }
    const items = Array.from(root.querySelectorAll(item));
    const first = items[0];
    const candidates: any[] = [];
    if (first) {
      const base = first.getBoundingClientRect();
      const seen = new Set<string>();
      const walk = (el: Element, depth: number) => {
        if (depth > 4) return;
        for (const child of Array.from(el.children)) {
          const own = Array.from(child.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
          const isLink = child.tagName === 'A' && child.hasAttribute('href');
          if (own || isLink) {
            const path: string[] = [];
            let cur: Element | null = child;
            while (cur && cur !== first && path.length < 4) { path.unshift(stable(cur)); cur = cur.parentElement; }
            const selector = path.join(' > ');
            if (!seen.has(selector) && first.querySelectorAll(selector).length >= 1) {
              seen.add(selector);
              const r = child.getBoundingClientRect();
              candidates.push({
                selector: first.querySelectorAll(selector).length === 1 || isLink ? selector : selector,
                text: (child.textContent || '').trim().replace(/\s+/g, ' '),
                href: isLink ? (child as HTMLAnchorElement).getAttribute('href') : undefined,
                fontSize: parseFloat(getComputedStyle(child).fontSize) || 14,
                top: r.top - base.top, left: r.left - base.left, isLink,
              });
            }
          }
          walk(child, depth + 1);
        }
      };
      walk(first, 1);
    }
    return { item, count: items.length, candidates };
  }, { container, itemSel });
  if (!res) throw new ApiError(422, 'container_not_found', '목록 영역을 찾지 못했어요');
  return { item: res.item, probe: { count: res.count, candidates: res.candidates as Candidate[] } };
}

// 항목 하나에서 selector 규칙대로 값을 뽑는다.
export async function extractItems(page: Evaluator, container: string, itemSel: string, fields: { key: string; selector: string; value: string }[], max: number) {
  return page.evaluate(({ container, itemSel, fields, max }) => {
    const root = document.querySelector(container);
    if (!root) return null;
    const items = Array.from(root.querySelectorAll(itemSel)).slice(0, max);
    const total = root.querySelectorAll(itemSel).length;
    return {
      total,
      rows: items.map((el) => {
        const values: Record<string, string | null> = {};
        for (const f of fields) {
          const t = el.querySelector(f.selector);
          if (!t) { values[f.key] = null; continue; }
          const v = f.value.startsWith('attr:') ? t.getAttribute(f.value.slice(5)) : (t.textContent || '').trim().replace(/\s+/g, ' ');
          values[f.key] = v === '' ? null : v;
        }
        return values;
      }),
    };
  }, { container, itemSel, fields, max });
}
