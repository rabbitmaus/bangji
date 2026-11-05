import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowDefinition } from './workflowTypes';
import { wf, wfErrorMessage, type RunDoc } from './workflowApi';
import { Dialog } from './Palette';
import { RUN_STATUS_TEXT } from './Canvas';

export interface RunTrigger { mode: 'sample' | 'full'; n: number }
export interface RunPanelProps {
  workflowId: string;
  revision: number;
  def: WorkflowDefinition;
  trigger: RunTrigger | null;
  onRunDoc: (doc: RunDoc | null) => void;
  onSelect: (id: string) => void;
}

const TERMINAL = ['completed', 'failed', 'cancelled', 'partial'];
const trunc = (v: unknown, n = 100) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const itemKey = (p: unknown, i: number): string => {
  const o = p as { itemId?: unknown; id?: unknown } | null;
  return String(o?.itemId ?? o?.id ?? i);
};
const safeHref = (u: unknown): string | null => (typeof u === 'string' && /^(https:\/\/|\/)/.test(u) ? u : null);

function Artifact({ a }: { a: unknown }) {
  if (typeof a === 'string') return <pre className="wf-pre">{a}</pre>;
  const o = (a ?? {}) as Record<string, unknown>;
  const text = typeof o.markdown === 'string' ? o.markdown : typeof o.content === 'string' ? o.content : null;
  const items = Array.isArray(o.items) ? o.items : null;
  const href = safeHref(o.url);
  const title = typeof o.title === 'string' ? o.title : typeof o.kind === 'string' ? o.kind : '산출물';
  return (
    <div className="wf-artifact">
      <strong>{title}</strong>
      {href && <> <a href={href} target="_blank" rel="noreferrer noopener">열기</a></>}
      {text && <pre className="wf-pre">{text}</pre>}
      {items && <ul>{items.map((it, i) => <li key={i}>{trunc(it, 160)}</li>)}</ul>}
      {!text && !items && !href && <pre className="wf-pre">{trunc(a, 400)}</pre>}
    </div>
  );
}

export function RunPanel({ workflowId, revision, def, trigger, onRunDoc, onSelect }: RunPanelProps) {
  const [runId, setRunId] = useState<string | null>(null);
  const [doc, setDoc] = useState<RunDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [picks, setPicks] = useState<Record<string, boolean>>({});
  const lastN = useRef(0);

  const refresh = useCallback(async (id: string) => {
    try {
      const d = await wf.getRun(id);
      setDoc(d);
      onRunDoc(d);
    } catch (e) {
      setError(wfErrorMessage(e));
    }
  }, [onRunDoc]);

  const start = async (mode: 'sample' | 'full') => {
    setError(null); setDoc(null); setPicks({}); onRunDoc(null);
    try {
      const r = await wf.startRun(workflowId, mode, revision, mode === 'sample' ? 3 : undefined);
      setRunId(r.runId);
      await refresh(r.runId);
    } catch (e) {
      setError(wfErrorMessage(e));
    }
  };

  useEffect(() => {
    if (!trigger || trigger.n === lastN.current) return;
    lastN.current = trigger.n;
    if (trigger.mode === 'full') setConfirm(true);
    else void start('sample');
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const terminal = !!doc && TERMINAL.includes(doc.status);
  useEffect(() => {
    if (!runId) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(wf.runEventsUrl(runId), { withCredentials: true });
      for (const ev of ['node.started', 'node.completed', 'node.failed', 'node.waiting', 'workflow.completed']) {
        es.addEventListener(ev, () => { void refresh(runId); });
      }
    } catch { /* 폴링으로 대체 */ }
    const timer = window.setInterval(() => { void refresh(runId); }, 3000);
    return () => { es?.close(); window.clearInterval(timer); };
  }, [runId, refresh]);

  useEffect(() => { if (terminal) onRunDoc(doc); }, [terminal]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); if (runId) await refresh(runId); } catch (e) { setError(wfErrorMessage(e)); }
  };

  const labelOf = (id: string) => def.nodes.find((n) => n.id === id)?.label || id;
  const ordered = doc ? Object.entries(doc.nodes ?? {}) : [];
  const L = def.limits;

  return (
    <section className="wf-panel" aria-label="실행">
      <h2>실행</h2>
      {error && <p role="alert" className="wf-issue-inline">{error}</p>}
      {!runId && <p className="wf-muted">‘샘플 실행’ 또는 ‘실행’을 눌러 시작하세요.</p>}
      {runId && (
        <div className="wf-row">
          <span>실행 상태: <strong>{doc ? RUN_STATUS_TEXT[doc.status] ?? doc.status : '불러오는 중…'}</strong></span>
          {!terminal && <button type="button" onClick={() => act(() => wf.cancel(runId))}>취소</button>}
        </div>
      )}
      <ul className="wf-run-list">
        {ordered.map(([id, s]) => (
          <li key={id} role="status" aria-label={`${labelOf(id)}: ${RUN_STATUS_TEXT[s.status] ?? s.status}`} className={`s-${s.status}`}>
            <div className="wf-row">
              <button type="button" className="wf-linklike" onClick={() => onSelect(id)}>{labelOf(id)}</button>
              <span className="wf-badge">{RUN_STATUS_TEXT[s.status] ?? s.status}</span>
              <span>입력 {s.inputCount} → 출력 {s.outputCount}</span>
              <span>모델 호출 {s.modelCalls}</span>
              {runId && <button type="button" onClick={() => act(() => wf.rerun(runId, id))}>여기서부터 다시 실행</button>}
            </div>
            {s.error && <p className="wf-issue-inline">오류: {typeof s.error === "string" ? s.error : s.error.message ?? s.error.code}</p>}
            {s.preview?.length > 0 && (
              <ul className="wf-preview">{s.preview.slice(0, 3).map((p, i) => <li key={i}>{trunc(p)}</li>)}</ul>
            )}
            {s.status === 'waiting' && runId && (
              <fieldset className="wf-review">
                <legend>사람 검토 필요</legend>
                {s.preview.map((p, i) => {
                  const k = `${id}:${itemKey(p, i)}`;
                  return (
                    <label key={k} className="wf-check">
                      <input type="checkbox" checked={!!picks[k]} onChange={(e) => setPicks({ ...picks, [k]: e.target.checked })} />
                      승인: {trunc(p, 80)}
                    </label>
                  );
                })}
                <button type="button" onClick={() => act(() => wf.review(runId, id,
                  s.preview.map((p, i) => ({ itemId: itemKey(p, i), approve: !!picks[`${id}:${itemKey(p, i)}`] }))))}>
                  검토 제출 (체크하지 않은 항목은 거절)
                </button>
              </fieldset>
            )}
          </li>
        ))}
      </ul>
      {terminal && doc && (
        <div className="wf-final">
          <h3>최종 결과</h3>
          {doc.summary && <p>{doc.summary}</p>}
          {(Array.isArray(doc.artifacts) ? doc.artifacts : Object.values(doc.artifacts ?? {})).map((a, i) => <Artifact key={i} a={a} />)}
        </div>
      )}
      {confirm && (
        <Dialog title="전체 실행 확인" onClose={() => setConfirm(false)}>
          <ul>
            <li>최대 항목 {L.maxItems}개, 상세 조회 {L.maxDetails}회</li>
            <li>모델 호출 최대 {L.maxModelCalls}회, 실행 시간 최대 {L.runSeconds}초</li>
            <li>external submit 없음 — 외부로 제출하지 않아요.</li>
          </ul>
          <div className="wf-row">
            <button type="button" onClick={() => { setConfirm(false); void start('full'); }}>실행 시작</button>
            <button type="button" onClick={() => setConfirm(false)}>취소</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
