import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { NodeCatalogEntry } from './workflowTypes';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => prev?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="wf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wf-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Palette({ catalog, onPick, onClose }: { catalog: NodeCatalogEntry[]; onPick: (e: NodeCatalogEntry) => void; onClose: () => void }) {
  return (
    <Dialog title="노드 추가" onClose={onClose}>
      <ul className="wf-palette">
        {catalog.map((c) => (
          <li key={c.kind}>
            <button type="button" className="wf-palette-item" disabled={!c.supported} onClick={() => onPick(c)} data-kind={c.kind}>
              <strong>{c.label}</strong> <code>{c.kind}</code>
              <span className="wf-muted">{c.description}{c.supported ? '' : ' (아직 지원하지 않아요)'}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="wf-row"><button type="button" onClick={onClose}>닫기</button></div>
    </Dialog>
  );
}
