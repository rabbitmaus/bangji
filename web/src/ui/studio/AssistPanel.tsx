import { useRef, useState } from 'react';
import type { DefinitionChange } from './workflowTypes';
import { wf, WfError, wfErrorMessage, type AssistProposal } from './workflowApi';

export function DiffList({ changes }: { changes: DefinitionChange[] }) {
  if (!changes?.length) return <p className="wf-muted">변경 사항이 없어요.</p>;
  const sym = { added: '+', removed: '−', changed: '~' } as const;
  return (
    <ul className="wf-diff">
      {changes.map((c, i) => <li key={i} className={`d-${c.op}`}><span aria-hidden="true">{sym[c.op]}</span> {c.summary}</li>)}
    </ul>
  );
}

const warnText = (w: unknown): string => (typeof w === 'string' ? w : (w as { message?: string })?.message ?? JSON.stringify(w));

export interface AssistPanelProps {
  workflowId: string;
  baseRevision: number;
  dirty: boolean;
  onApplied: () => Promise<void> | void;
}

export function AssistPanel({ workflowId, baseRevision, dirty, onApplied }: AssistPanelProps) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[]>([]);
  const [proposal, setProposal] = useState<AssistProposal | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const request = async () => {
    if (!message.trim() || busy) return;
    setBusy(true); setTools([]); setProposal(null); setFailed(null); setNote(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await wf.assist(workflowId, message.trim(), baseRevision, (m) => {
        const d = m.data as any;
        if (m.event === 'assist.started') setTools((t) => [...t, 'AI가 요청을 읽고 있어요…']);
        else if (m.event === 'assist.tool') setTools((t) => [...t, typeof d === 'string' ? d : d?.summary ?? d?.name ?? d?.tool ?? '도구 사용 중…']);
        else if (m.event === 'assist.proposal') setProposal(d as AssistProposal);
        else if (m.event === 'assist.failed') setFailed(d?.reason ?? '변경안을 만들지 못했어요');
      }, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setFailed(wfErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setNote(null);
    try {
      await wf.applyProposal(workflowId, proposal.proposalId, proposal.baseRevision);
      setProposal(null);
      setNote('변경안을 적용했어요.');
      await onApplied();
    } catch (e) {
      if (e instanceof WfError && e.status === 409) setNote('워크플로가 그 사이 바뀌었어요. 변경안이 오래됐으니 다시 요청해 주세요.');
      else setNote(wfErrorMessage(e));
    }
  };

  const reject = async () => {
    if (!proposal) return;
    try { await wf.rejectProposal(workflowId, proposal.proposalId); } catch { /* 거절은 실패해도 화면에서 닫는다 */ }
    setProposal(null);
    setNote('변경안을 거절했어요.');
  };

  return (
    <section className="wf-panel" aria-label="AI 변경안">
      <h2>AI 변경안</h2>
      {dirty && <p className="wf-muted">저장하지 않은 변경이 있어요. 저장한 뒤 요청하면 최신 내용 기준으로 제안해요.</p>}
      <div className="wf-field">
        <label htmlFor="wf-ai-msg">AI 요청</label>
        <textarea id="wf-ai-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="예: 평가 전에 중복 제거 단계를 넣어줘" />
      </div>
      <div className="wf-row">
        <button type="button" onClick={request} disabled={busy || !message.trim() || dirty}>변경안 요청</button>
        {busy && <button type="button" onClick={() => abortRef.current?.abort()}>중단</button>}
      </div>
      <div aria-live="polite" className="wf-live">
        {tools.length > 0 && <ul className="wf-tools">{tools.map((t, i) => <li key={i}>{t}</li>)}</ul>}
        {failed && <p role="alert" className="wf-issue-inline">변경안 실패: {failed}</p>}
        {note && <p>{note}</p>}
        {proposal && (
          <div className="wf-proposal">
            <span className="wf-ai-tag">AI가 생성한 변경안</span>
            {proposal.rationale && <p className="wf-muted">{proposal.rationale}</p>}
            <ul>{(proposal.summaryKo ?? []).map((s, i) => <li key={i}>{s}</li>)}</ul>
            <p className={proposal.validation?.ok ? 'wf-ok' : 'wf-issue-inline'}>
              검증: {proposal.validation?.ok ? '통과' : `오류 ${proposal.validation?.errors?.length ?? 0}건`}
            </p>
            {proposal.validation?.errors?.map((e, i) => <p key={i} className="wf-issue-inline">⚠ {e.message}</p>)}
            {(proposal.warnings ?? []).map((w, i) => <p key={i} className="wf-muted">주의: {warnText(w)}</p>)}
            <DiffList changes={proposal.diff ?? []} />
            <div className="wf-row">
              <button type="button" onClick={apply} disabled={!proposal.validation?.ok}>적용</button>
              <button type="button" onClick={reject}>거절</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
