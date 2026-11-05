import { z } from 'zod';
import type { ToolSpec } from '../copilot/client.js';
import { getPage } from './browserAdapter.js';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('시간 초과')), ms))]);

/** 워크스페이스·브라우저 세션에 클로저로 묶은 읽기 전용 도구. 모델은 세션 ID나 URL을 지정할 수 없다. */
export function buildTools(workspaceId: string, browserSessionId: string): ToolSpec[] {
  return [
    {
      name: 'get_dom_outline',
      description: '현재 페이지의 DOM 윤곽(태그, id, class, 자식 수, 텍스트 앞 40자)을 읽는다. 최대 노드 200개, 읽기 전용.',
      parameters: z.object({ selector: z.string().max(300).optional(), depth: z.number().int().min(1).max(3).optional() }),
      async handler(args: { selector?: string; depth?: number }) {
        const page = await getPage(workspaceId, browserSessionId);
        if (!page) return { error: '브라우저 세션을 찾지 못했어요' };
        try {
          return await withTimeout(page.evaluate(({ selector, depth }) => {
            const root = selector ? document.querySelector(selector) : document.body;
            if (!root) return { error: 'selector와 일치하는 요소가 없어요' };
            let count = 0;
            const walk = (el: Element, d: number): unknown => {
              if (count++ >= 200) return null;
              const node: Record<string, unknown> = {
                tag: el.tagName.toLowerCase(), id: el.id || undefined,
                class: typeof el.className === 'string' && el.className ? el.className.slice(0, 80) : undefined,
                children: el.children.length,
                text: (el.childNodes.length && Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim().slice(0, 40)) || undefined,
              };
              if (d > 0) node.items = Array.from(el.children).map((c) => walk(c, d - 1)).filter(Boolean);
              return node;
            };
            return { outline: walk(root, depth) };
          }, { selector: args.selector, depth: Math.min(args.depth ?? 3, 3) }), 3000);
        } catch (e) { return { error: (e as Error).message }; }
      },
    },
    {
      name: 'preview_extraction',
      description: '컨테이너·항목·필드 selector로 수집 결과를 미리 본다(항목 수, 샘플 5건, 필드별 채움 비율). 페이지 이동 없음.',
      parameters: z.object({
        containerSelector: z.string().max(300),
        itemSelector: z.string().max(300),
        fields: z.array(z.object({ name: z.string().max(40), selector: z.string().max(300), attr: z.string().max(40).optional() })).max(12),
      }),
      async handler(args: { containerSelector: string; itemSelector: string; fields: { name: string; selector: string; attr?: string }[] }) {
        const page = await getPage(workspaceId, browserSessionId);
        if (!page) return { error: '브라우저 세션을 찾지 못했어요' };
        try {
          return await withTimeout(page.evaluate((a) => {
            const container = document.querySelector(a.containerSelector);
            if (!container) return { error: '컨테이너를 찾지 못했어요', itemCount: 0 };
            const items = Array.from(container.querySelectorAll(a.itemSelector)).slice(0, 200);
            const read = (it: Element, f: { selector: string; attr?: string }) => {
              const el = f.selector ? it.querySelector(f.selector) : it;
              const v = el ? (f.attr ? el.getAttribute(f.attr) : el.textContent) : null;
              return v ? v.trim().replace(/\s+/g, ' ').slice(0, 120) : null;
            };
            const rows = items.map((it) => Object.fromEntries(a.fields.map((f) => [f.name, read(it, f)])));
            const fillRate = Object.fromEntries(a.fields.map((f) => [f.name, rows.length ? rows.filter((r) => r[f.name]).length / rows.length : 0]));
            return { itemCount: items.length, samples: rows.slice(0, 5), fillRate };
          }, args), 3000);
        } catch (e) { return { error: (e as Error).message }; }
      },
    },
  ];
}
