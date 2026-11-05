import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError, api,
  type ChoiceDecision, type EventEnvelope, type TailorChange, type TailorSentence, type Verification,
} from './api';
import { download, useEventStream } from './hooks';
import { Field, Notice, Spinner, useAction } from './common';

const EVENTS = [
  'tailoring.started', 'draft.delta', 'draft.completed', 'verification.result', 'approval.requested',
  'tailoring.completed', 'tailoring.failed', 'heartbeat',
];
const REASON_TEXT: Record<string, string> = {
  no_source: '근거 사실이 없음',
  unknown_fact: '확인된 사실 목록에 없는 ID',
  number_not_in_source: '숫자·기간이 원본에 없음',
  entity_not_in_source: '회사·직함이 원본에 없음',
  credential_not_in_source: '자격증·학위가 원본에 없음',
  skill_not_in_source: '기술 이름이 원본에 없음',
  unknown_requirement: '공고에 없는 요구사항',
};
const CHANGE_TEXT: Record<string, string> = { modified: '수정', added: '추가', removed: '삭제', reordered: '순서 변경' };
interface TailoringSnapshot {
  evaluationRunId: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed';
  head?: { title?: string };
  sentences: (TailorSentence & { status?: string; reasons?: string[] })[];
  originals: unknown;
  changes: TailorChange[];
  decisions: Record<string, ChoiceDecision>;
  finalMarkdown?: string;
  failureCode?: string;
}

export function TailoringView({ id, go }: { id: string; go: (to: string) => void }) {
  const [status, setStatus] = useState<'running' | 'awaiting' | 'completed' | 'failed'>('running');
  const [failure, setFailure] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [sentences, setSentences] = useState<TailorSentence[]>([]);
  const [verif, setVerif] = useState<Record<string, Verification>>({});
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [changes, setChanges] = useState<TailorChange[]>([]);
  const [choice, setChoice] = useState<Record<string, ChoiceDecision>>({});
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('맞춤 이력서');
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const restoredReview = useRef(false);
  const seen = useRef(new Set<number>());
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(() => load.run(async () => {
    const response = await fetch(`/api/tailorings/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new ApiError(response.status, 'load_failed', `맞춤 이력서를 불러오지 못했어요 (${response.status}).`, true);
    const snapshot: TailoringSnapshot = await response.json();
    setRunId(snapshot.evaluationRunId);
    setTitle(snapshot.head?.title ? `${snapshot.head.title} 맞춤 이력서` : '맞춤 이력서');
    setSentences(snapshot.sentences ?? []);
    setOriginals(toMap(snapshot.originals));
    setChanges(snapshot.changes ?? []);
    setChoice(snapshot.decisions ?? {});
    setVerif(Object.fromEntries((snapshot.sentences ?? []).filter((s) => s.status === 'verified' || s.status === 'unsupported').map((s) => [
      s.sentenceId, { sentenceId: s.sentenceId, status: s.status as Verification['status'], reasons: s.reasons },
    ])));
    setMarkdown(snapshot.finalMarkdown ?? null);
    setFailure(snapshot.failureCode ?? null);
    restoredReview.current = snapshot.status !== 'running';
    setStatus(snapshot.status === 'awaiting_approval' ? 'awaiting' : snapshot.status);
    setLoaded(true);
  }), [id, load.run]);
  useEffect(() => { void refresh(); }, [refresh]);

  const onEvent = useCallback((name: string, d: EventEnvelope) => {
    if (typeof d.seq === 'number') {
      if (seen.current.has(d.seq)) return;
      seen.current.add(d.seq);
    }
    // Replayed drafting events must not replace saved edits and review choices.
    if (restoredReview.current && !['tailoring.completed', 'tailoring.failed'].includes(name)) return;
    switch (name) {
      case 'tailoring.started':
        if (d.title || d.posting?.title) setTitle(`${d.title ?? d.posting?.title} 맞춤 이력서`);
        break;
      case 'draft.delta':
        setDraftText((t) => t + (d.text ?? d.delta ?? ''));
        break;
      case 'draft.completed':
        setSentences(d.sentences ?? []);
        if (d.originals) setOriginals(toMap(d.originals));
        break;
      case 'verification.result': {
        const list: Verification[] = d.results ?? d.sentences ?? (d.sentenceId ? [d] : []);
        setVerif((m) => {
          const n = { ...m };
          list.forEach((r) => (n[r.sentenceId] = { sentenceId: r.sentenceId, status: r.status, reasons: r.reasons ?? ((r as any).reason ? [(r as any).reason] : undefined) }));
          return n;
        });
        break;
      }
      case 'approval.requested':
        setChanges(d.changes ?? []);
        if (d.originals) setOriginals(toMap(d.originals));
        if (d.sentences) setSentences(d.sentences);
        setStatus('awaiting');
        break;
      case 'tailoring.completed':
        setMarkdown(d.markdown ?? null);
        setStatus('completed');
        break;
      case 'tailoring.failed':
        setFailure(d.message ?? d.code ?? '알 수 없는 사유');
        setStatus('failed');
        break;
    }
  }, []);
  const connected = useEventStream(loaded && (status === 'running' || status === 'awaiting') ? `/api/tailorings/${id}/events` : null, EVENTS, onEvent, ['tailoring.completed', 'tailoring.failed']);

  const byId = useMemo(() => Object.fromEntries(sentences.map((s) => [s.sentenceId, s])), [sentences]);
  const canAccept = (c: TailorChange) => c.type === 'removed' || (!!c.sentenceId && verif[c.sentenceId]?.status === 'verified');

  const decisions = () =>
    changes.filter((c) => c.type !== 'reordered').map((c) => ({ changeId: c.id, decision: canAccept(c) ? choice[c.id] ?? ('reject' as ChoiceDecision) : 'reject' as ChoiceDecision }));

  const copy = async (md: string) => {
    setCopied(false);
    if (!navigator.clipboard?.writeText) throw new Error('이 브라우저에서는 클립보드를 사용할 수 없어요. Markdown을 다운로드하거나 아래 내용을 직접 복사해 주세요.');
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
    } catch {
      throw new Error('클립보드에 접근하지 못했어요. 브라우저 권한을 확인하거나 Markdown을 다운로드해 주세요.');
    }
  };

  const approve = (mode: 'download' | 'copy') =>
    act.run(async () => {
      setFeedback('');
      setCopied(false);
      await api.decide(id, decisions(), true);
      setStatus('completed');
      const md = await api.exportMarkdown(id);
      setMarkdown(md);
      if (mode === 'download') {
        download(`tailored-resume-${id}.md`, md);
        setFeedback('승인한 이력서의 다운로드를 시작했어요.');
      }
      else await copy(md);
    });

  const saveDraft = () => act.run(async () => {
    setFeedback('');
    await api.decide(id, decisions(), false);
    setFeedback('결정을 저장했어요. 아직 최종 승인하거나 내보내지 않았어요.');
  });

  const edit = async (s: TailorSentence, text: string, addFact?: string) => {
    const result = await act.run(async () => {
      setFeedback('');
      const r = await api.editSentence(id, s.sentenceId, { text, ...(addFact ? { addFact: { text: addFact } } : {}) });
      const updatedChanges = (r as typeof r & { changes?: TailorChange[] }).changes;
      if (updatedChanges) setChanges(updatedChanges);
      if (r.sentence) setSentences((all) => all.map((x) => (x.sentenceId === s.sentenceId ? r.sentence! : x)));
      else setSentences((all) => all.map((x) => (x.sentenceId === s.sentenceId ? { ...x, text } : x)));
      setVerif((m) => {
        const next = { ...m };
        delete next[s.sentenceId];
        if (r.verification) next[s.sentenceId] = r.verification;
        return next;
      });
      setChoice((m) => {
        const next = { ...m };
        changes.filter((c) => c.sentenceId === s.sentenceId).forEach((c) => delete next[c.id]);
        return next;
      });
      setFeedback(r.verification?.status === 'verified' ? '문장을 저장하고 검증했어요. 변경 내용을 다시 수락해 주세요.' : '문장을 저장했어요. 검증 결과를 확인하고 필요한 내용을 수정해 주세요.');
      return true;
    });
    return result === true;
  };

  const visibleChanges = changes.filter((c) => c.type !== 'reordered');
  const reordered = changes.some((c) => c.type === 'reordered');
  const accepted = visibleChanges.filter((c) => canAccept(c) && choice[c.id] === 'accept').length;
  const undecided = visibleChanges.filter((c) => !choice[c.id] || (!canAccept(c) && choice[c.id] === 'accept')).length;
  const locked = act.busy || editing.size > 0;
  const returnToResults = () => {
    if (editing.size > 0 && !window.confirm('수정 중인 문장이 있어요. 저장하지 않고 결과 보드로 돌아갈까요?')) return;
    go(runId ? `/runs/${encodeURIComponent(runId)}` : '/');
  };

  if (!loaded) return (
    <div className="stack">
      <h1>맞춤 이력서</h1>
      {load.error ? <><Notice kind="error">{load.error}</Notice><div className="row wrap"><button type="button" className="btn btn-primary" disabled={load.busy} onClick={() => void refresh()}>다시 불러오기</button><button type="button" className="btn" onClick={() => go('/')}>홈으로</button></div></> : <Spinner label="저장된 이력서를 불러오는 중…" />}
    </div>
  );

  return (
    <div className="stack">
      <div className="row wrap between page-heading">
        <h1>{title}</h1>
        <button type="button" className="btn" disabled={act.busy} onClick={returnToResults}>{runId ? '결과 보드로' : '홈으로'}</button>
      </div>
      <Notice kind="info">AI가 작성한 초안이에요. 검증을 통과하고 수락한 변경만 반영해요. 거절한 수정·삭제는 원문을 유지하고, 거절한 추가 문장은 제외해요. 외부 사이트로 제출되지 않아요.</Notice>
      {!connected && (status === 'running' || status === 'awaiting') && <p className="hint" role="status">진행 상황에 연결 중이에요. 연결이 끊기면 자동으로 다시 연결해요.</p>}
      {status === 'failed' && <Notice kind="error">맞춤 이력서 생성에 실패했어요: {failure}</Notice>}
      {load.error && <Notice kind="error">{load.error}</Notice>}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {act.busy && <Spinner label="요청을 처리하는 중…" />}
      {feedback && <Notice kind="ok">{feedback}</Notice>}
      {copied && <Notice kind="ok">클립보드에 복사했어요.</Notice>}

      {status === 'running' && (
        <section className="card stack">
          <Spinner label="초안을 만들고 사실을 검증하는 중…" />
          <button type="button" className="btn" disabled={load.busy} onClick={() => void refresh()}>상태 새로고침</button>
          {draftText && <pre className="stream" aria-live="polite">{draftText}</pre>}
          {sentences.length > 0 && (
            <ul className="plain">
              {sentences.map((s) => (
                <li key={s.sentenceId}>{s.text} <VerifBadge v={verif[s.sentenceId]} /></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(status === 'awaiting' || status === 'completed') && (
        <section className="card stack" aria-label="문장 비교">
          <h2>원본과 변경 비교</h2>
          {reordered && <p className="hint">일부 문장은 순서만 바뀌었어요(별도 결정 없음).</p>}
          {visibleChanges.length === 0 && <p className="hint">결정할 변경이 없어요.</p>}
          <ul className="plain stack">
            {visibleChanges.map((c) => {
              const s = c.sentenceId ? byId[c.sentenceId] : undefined;
              const orig = (c.originalRefs ?? s?.originalRefs ?? []).map((r) => ({ ref: r, text: originals[r] }));
              const blocked = !canAccept(c);
              const sel = blocked && choice[c.id] === 'accept' ? undefined : choice[c.id];
              return (
                <li key={c.id} className="card card-inner">
                  <div className="row wrap between">
                    <strong>{CHANGE_TEXT[c.type]} · {c.sentenceId ?? c.id}</strong>
                    <VerifBadge v={c.sentenceId ? verif[c.sentenceId] : undefined} />
                  </div>
                  <div className="compare">
                    <div>
                      <h4>원문</h4>
                      {orig.length === 0 ? <p className="hint">(원본 없음)</p> : orig.map((o) => <p key={o.ref}><span className="badge">{o.ref}</span> {o.text}</p>)}
                    </div>
                    <div>
                      <h4>변경</h4>
                      {c.type === 'removed' ? <p className="hint">(삭제됨)</p> : s ? <SentenceEditor s={s} v={verif[s.sentenceId]} onSave={edit} busy={act.busy} error={act.error} readOnly={status === 'completed'} onEditing={(isEditing) => setEditing((ids) => { const next = new Set(ids); if (isEditing) next.add(c.id); else next.delete(c.id); return next; })} /> : <p className="hint">문장을 아직 불러오지 못했어요. 이 변경은 수락할 수 없어요.</p>}
                    </div>
                  </div>
                  {blocked && <Notice kind="warn">{c.sentenceId && verif[c.sentenceId]?.status === 'unsupported' ? '원본에 없는 내용이에요. 문장을 고치거나 근거 사실을 추가해 검증을 통과해야 수락할 수 있어요.' : '검증을 통과한 뒤 수락할 수 있어요. 검증 전에는 내보내기에 반영하지 않아요.'}</Notice>}
                  {status === 'awaiting' && (
                    <fieldset className="manual" disabled={act.busy || editing.has(c.id)}>
                      <legend>{c.sentenceId ?? c.id} 결정</legend>
                      <div className="seg">
                        <label className={`btn ${sel === 'accept' ? 'btn-primary' : ''}`} aria-disabled={blocked || undefined}><input className="sr" type="radio" name={`choice-${c.id}`} value="accept" checked={sel === 'accept'} disabled={blocked} onChange={() => { setChoice((m) => ({ ...m, [c.id]: 'accept' })); setFeedback(''); }} />수락</label>
                        <label className={`btn ${sel === 'reject' ? 'btn-primary' : ''}`}><input className="sr" type="radio" name={`choice-${c.id}`} value="reject" checked={sel === 'reject'} onChange={() => { setChoice((m) => ({ ...m, [c.id]: 'reject' })); setFeedback(''); }} />거절</label>
                      </div>
                    </fieldset>
                  )}
                </li>
              );
            })}
          </ul>
          {status === 'awaiting' && (
            <div className="stack">
              <h3>검토를 마치고 내보내기</h3>
              <p role="status">수락 {accepted}건 · 거절 {visibleChanges.length - accepted - undecided}건 · 미결정 {undecided}건</p>
              <p className="hint" id="export-help">내보내기 또는 복사를 누르면 최종 승인돼요. 결정하지 않은 변경은 거절로 처리돼요. 수정 중인 문장은 먼저 저장하거나 취소해 주세요.</p>
              <div className="row wrap action-bar" aria-describedby="export-help">
                <button type="button" className="btn" disabled={locked} onClick={() => void saveDraft()}>결정 저장</button>
                <button type="button" className="btn btn-primary" disabled={locked} onClick={() => void approve('download')}>Markdown 내보내기</button>
                <button type="button" className="btn" disabled={locked} onClick={() => void approve('copy')}>복사</button>
              </div>
            </div>
          )}
        </section>
      )}

      {status === 'completed' && (
        <section className="card stack">
          <h2>최종 Markdown</h2>
          {markdown !== null ? <>
            <p className="hint">최종 승인된 이력서예요. 파일을 확인한 뒤 원 사이트에서 직접 지원해 주세요.</p>
            <div className="row wrap action-bar">
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => { download(`tailored-resume-${id}.md`, markdown); setFeedback('다운로드를 시작했어요.'); }}>Markdown 내보내기</button>
              <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(() => copy(markdown))}>복사</button>
            </div>
            <pre className="code" tabIndex={0} aria-label="최종 이력서 내용">{markdown}</pre>
          </> : <>
            <p>승인은 완료됐어요. 최종 파일을 다시 불러오면 내보낼 수 있어요.</p>
            <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(async () => { setMarkdown(await api.exportMarkdown(id)); })}>최종 파일 다시 불러오기</button>
          </>}
        </section>
      )}
      {status === 'failed' && <div className="card empty-state"><p>결과 보드에서 공고를 확인하고 맞춤 이력서를 다시 시작해 주세요. 실행당 생성 한도가 적용돼요.</p><button type="button" className="btn btn-primary" onClick={returnToResults}>{runId ? '결과 보드로 돌아가기' : '홈으로'}</button></div>}
    </div>
  );
}

function toMap(v: unknown): Record<string, string> {
  if (Array.isArray(v)) return Object.fromEntries(v.map((o: any) => [o.id ?? o.ref, o.text]));
  return (v as Record<string, string>) ?? {};
}

function VerifBadge({ v }: { v?: Verification }) {
  if (!v) return <span className="badge">검증 대기</span>;
  if (v.status === 'verified') return <span className="badge badge-pass">검증됨</span>;
  return (
    <span className="badge badge-reject" title={(v.reasons ?? []).map((r) => REASON_TEXT[r] ?? r).join(', ')}>
      원본에 없는 내용{v.reasons?.length ? ` · ${v.reasons.map((r) => REASON_TEXT[r] ?? r).join(', ')}` : ''}
    </span>
  );
}

function SentenceEditor({ s, v, onSave, busy, readOnly, onEditing, error }: {
  error?: string | null;
  s: TailorSentence; v?: Verification; busy: boolean; readOnly: boolean;
  onSave: (s: TailorSentence, text: string, addFact?: string) => Promise<boolean>;
  onEditing: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const [fact, setFact] = useState('');
  if (!editing)
    return (
      <div>
        <p>{s.text}</p>
        {!readOnly && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setText(s.text); setFact(''); setEditing(true); onEditing(true); }}>문장 수정</button>}
      </div>
    );
  return (
    <div className="stack">
      <Field label={`${s.sentenceId} 문장`}>
        <textarea rows={3} maxLength={1000} disabled={busy} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {v?.status === 'unsupported' && (
        <Field label="근거 사실 추가(사용자 추가로 저장돼요)" hint="이력서에 실제로 있는 내용만 적어 주세요.">
          <input maxLength={500} disabled={busy} value={fact} onChange={(e) => setFact(e.target.value)} />
        </Field>
      )}
      {error && <Notice kind="error">수정 내용은 그대로 두었어요. 다시 시도해 주세요.</Notice>}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void onSave(s, text, fact.trim() || undefined).then((saved) => { if (saved) { setEditing(false); onEditing(false); } })}>
          다시 검증
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(false); onEditing(false); }}>취소</button>
      </div>
    </div>
  );
}
