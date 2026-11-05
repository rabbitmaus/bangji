import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  HOLD_REASON_TEXT, api,
  type Decision, type EventEnvelope, type RunDiff, type RunSummary, type Verdict,
} from './api';
import { newKey, useEventStream } from './hooks';
import { DECISION_TEXT, DecisionBadge, Notice, Spinner, fmtTime, useAction, type WizardState } from './common';

interface TimelineEntry { seq: number; name: string; text: string }

const RUN_EVENTS = [
  'run.started', 'stage.changed', 'collect.progress', 'item.collected', 'executor.started', 'executor.completed',
  'verdict.partial', 'review.changed', 'verdict.final', 'run.completed', 'run.failed', 'heartbeat',
];
const STAGES = ['수집', '평가', '검토', '완료'];
const STAGE_KEY: Record<string, number> = {
  collect: 0, collecting: 0, 수집: 0, evaluate: 1, evaluating: 1, 평가: 1, review: 2, reviewing: 2, 검토: 2, done: 3, completed: 3, 완료: 3,
};

const effective = (v: Verdict): Decision => v.manual?.decision ?? v.decision;

function describe(name: string, d: EventEnvelope): string {
  switch (name) {
    case 'run.started': return '실행을 시작했어요';
    case 'stage.changed': return `단계: ${d.stage ?? ''}`;
    case 'collect.progress': return `수집 ${d.done ?? d.completed ?? 0}/${d.total ?? '?'}`;
    case 'item.collected': return `공고 수집: ${d.itemKey ?? ''} ${d.summary?.title ?? d.summary ?? ''}${d.injectionSuspected ? ' ⚠ 인젝션 의심' : ''}`;
    case 'executor.started': return `${d.itemKey ?? ''} ${d.executor ?? d.name ?? ''} 시작`;
    case 'executor.completed': return `${d.itemKey ?? ''} ${d.executor ?? d.name ?? ''} 완료${d.durationMs != null ? ` (${d.durationMs}ms)` : ''}`;
    case 'verdict.partial': return `${d.itemKey} 잠정 판정: ${d.decision ?? ''}`;
    case 'review.changed': return `${d.itemKey} 검토가 ${d.from ?? d.before} → ${d.to ?? d.after}로 바꿈${d.reason ? ` (${d.reason})` : ''}`;
    case 'verdict.final': return `${d.itemKey} 확정: ${d.decision}`;
    case 'run.completed': return `실행 완료 (판정 ${d.count ?? d.verdicts ?? ''}건)`;
    case 'run.failed': return `실행 실패: ${d.code ?? d.failureCode ?? ''} ${d.message ?? ''}`;
    default: return name;
  }
}

export function RunView({ runId, go, wiz }: { runId: string; go: (to: string) => void; wiz: WizardState }) {
  const isDemo = runId === 'demo';
  const [run, setRun] = useState<RunSummary | null>(null);
  const [live, setLive] = useState<Record<string, Verdict>>({});
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [stage, setStage] = useState(-1);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState<'all' | Decision>('all');
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const load = useAction();
  const ctl = useAction();
  const seen = useRef(new Set<string>());

  const refresh = useCallback(
    () =>
      load.run(async () => {
        const r = isDemo ? await api.demoSeedRun() : await api.getRun(runId);
        setRun(r);
        setStage(r.status === 'completed' ? 3 : STAGE_KEY[r.stage ?? ''] ?? -1);
        setLive({});
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, isDemo, load.run],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = !isDemo && !!run && (run.status === 'running' || run.status === 'queued');

  const onEvent = useCallback(
    (name: string, d: EventEnvelope) => {
      if (name === 'heartbeat') return;
      const id = `${name}:${d.seq}`;
      if (seen.current.has(id)) return;
      seen.current.add(id);
      setTimeline((t) => [...t, { seq: d.seq, name, text: describe(name, d) }].slice(-300));
      if (name === 'stage.changed') setStage(STAGE_KEY[String(d.stage)] ?? -1);
      if (name === 'collect.progress') setProgress({ done: d.done ?? d.completed ?? 0, total: d.total ?? 0 });
      if (name === 'item.collected')
        setLive((m) => ({
          ...m,
          [d.itemKey]: { ...m[d.itemKey], decision: m[d.itemKey]?.decision ?? 'hold', itemKey: d.itemKey, fields: d.summary && typeof d.summary === 'object' ? d.summary : m[d.itemKey]?.fields, injectionSuspected: d.injectionSuspected || m[d.itemKey]?.injectionSuspected },
        }));
      if (name === 'verdict.partial' || name === 'verdict.final')
        setLive((m) => ({
          ...m,
          [d.itemKey]: {
            ...m[d.itemKey],
            itemKey: d.itemKey,
            decision: d.decision,
            criteria: d.criteria ?? m[d.itemKey]?.criteria,
            holdReasons: d.holdReasons ?? m[d.itemKey]?.holdReasons,
            injectionSuspected: d.injectionSuspected ?? m[d.itemKey]?.injectionSuspected,
          },
        }));
      if (name === 'run.completed' || name === 'run.failed') void refresh();
    },
    [refresh],
  );
  const connected = useEventStream(active ? `/api/runs/${runId}/events` : null, RUN_EVENTS, onEvent, ['run.completed', 'run.failed']);

  const verdicts = useMemo(() => {
    const map = new Map<string, Verdict>();
    run?.verdicts.forEach((v) => map.set(v.itemKey, v));
    Object.values(live).forEach((v) => map.set(v.itemKey, { ...map.get(v.itemKey), ...v }));
    return [...map.values()];
  }, [run, live]);

  const counts = { pass: 0, reject: 0, hold: 0 };
  verdicts.forEach((v) => counts[effective(v)]++);
  const shown = verdicts.filter((v) => filter === 'all' || effective(v) === filter);

  const cancel = () => {
    if (!window.confirm('진행 중인 실행을 취소할까요? 이미 수집된 결과는 남아요.')) return;
    return ctl.run(async () => { await api.cancelRun(runId); await refresh(); });
  };
  const reeval = (withCurrent: boolean) =>
    ctl.run(async () => {
      if (withCurrent && !window.confirm(`마법사의 현재 조건 ${wiz.criteria.length}개로 재평가할까요? 이 실행의 조건 버전과 다를 수 있어요.`)) return;
      const r = await api.reevaluate(runId, withCurrent && wiz.criteria.length ? wiz.criteria : undefined);
      go(`/runs/${r.id}`);
    });
  const showDiff = () =>
    ctl.run(async () => {
      if (run?.baseRunId) setDiff(await api.diff(runId, run.baseRunId));
    });

  if (load.error && !run) return (
    <div className="stack">
      <Notice kind="error">{load.error}</Notice>
      <button type="button" className="btn btn-primary" disabled={load.busy} onClick={() => void refresh()}>다시 불러오기</button>
      <button type="button" className="btn" onClick={() => go('/')}>홈으로</button>
    </div>
  );
  if (!run) return <Spinner label="결과를 불러오는 중…" />;

  const collectLabel =
    run.collectionStatus === 'empty' ? '빈 목록' : run.collectionStatus === 'failed' ? `실패(${run.failureCode ?? '알 수 없음'})` : run.collectionStatus === 'success' ? '성공' : null;

  return (
    <div className="stack">
      <div className="row wrap between page-heading">
        <div>
          <h1>{isDemo ? '미리 실행된 데모 결과' : '실행 결과'}</h1>
          <p className="hint">{active ? '판정이 순서대로 도착해요. 실행이 끝나면 수동 검토와 맞춤 이력서를 시작할 수 있어요.' : '판정의 근거를 확인하고, 통과한 공고의 맞춤 이력서를 만들어 보세요.'}</p>
        </div>
        <div className="row wrap">
          {active && <button type="button" className="btn btn-danger" onClick={() => void cancel()} disabled={ctl.busy}>취소</button>}
          {!isDemo && !run.readOnly && !active && (
            <>
              <button type="button" className="btn" onClick={() => void reeval(false)} disabled={ctl.busy}>같은 조건으로 재평가</button>
              <button type="button" className="btn" onClick={() => void reeval(true)} disabled={ctl.busy || wiz.criteria.length === 0}>바뀐 조건으로 재평가</button>
              {run.baseRunId && <button type="button" className="btn" onClick={() => void showDiff()} disabled={ctl.busy}>이전 실행과 비교</button>}
            </>
          )}
          {isDemo && <button type="button" className="btn btn-primary" onClick={() => go('/')}>직접 해 보기</button>}
        </div>
      </div>
      {ctl.error && <Notice kind="error">{ctl.error}</Notice>}
      {ctl.busy && <Spinner label="요청을 처리하는 중…" />}
      {load.error && <Notice kind="error">{load.error} <button type="button" className="btn" disabled={load.busy} onClick={() => void refresh()}>다시 불러오기</button></Notice>}

      <section className="card">
        <dl className="summary">
          <dt>상태</dt><dd role="status">{statusText(run.status)}</dd>
          {collectLabel && <><dt>수집</dt><dd>{collectLabel}</dd></>}
          <dt>실행 시각</dt><dd>{fmtTime(run.startedAt ?? run.completedAt)}</dd>
          <dt>수집 시각</dt><dd>{fmtTime(run.collectedAt)}</dd>
          {run.criteriaVersion != null && <><dt>평가 조건</dt><dd>{run.criteriaVersion}번째 조건 버전으로 평가됨</dd></>}
          <dt>계약 버전</dt><dd>{run.contractVersion != null ? `v${run.contractVersion}` : '-'}</dd>
          {run.baseRunId && <><dt>비교 기준</dt><dd>{run.baseRunId}</dd></>}
        </dl>
        {run.status === 'failed' && (
          <Notice kind="error">
            실행이 실패했어요{run.failureCode ? ` (${run.failureCode})` : ''}. {run.failureMessage}
            <div className="row"><button type="button" className="btn" onClick={() => go('/wizard')}>설정 확인하기</button>
              {!run.readOnly && <button type="button" className="btn" disabled={ctl.busy} onClick={() => void reeval(false)}>재시도</button>}</div>
          </Notice>
        )}
        {run.status === 'partial' && (
          <Notice kind="warn">
            일부 공고가 보류되어 부분 결과예요.
            {run.failureSummary && Object.keys(run.failureSummary).length > 0 && (
              <ul className="plain">{Object.entries(run.failureSummary).map(([k, n]) => <li key={k}>{k}: {n}건</li>)}</ul>
            )}
          </Notice>
        )}
        {run.collectionStatus === 'empty' && <Notice kind="warn">컨테이너는 찾았지만 항목이 0개예요(빈 목록). 실패와는 달라요.</Notice>}
        {run.collectionStatus === 'failed' && <Notice kind="error">수집에 실패했어요: {run.failureCode ?? '알 수 없는 사유'}. 영역을 다시 고르거나 재시도해 보세요.</Notice>}
        {run.status === 'cancelled' && <Notice kind="info">실행을 취소했어요. 남은 공고는 평가되지 않았을 수 있어요. 같은 조건으로 다시 평가하거나 설정을 바꿀 수 있어요.</Notice>}
        {isDemo && <p className="hint">데모는 읽기 전용이에요. 직접 실행하면 수동 판정과 맞춤 이력서를 사용할 수 있어요.</p>}
        {!isDemo && !active && wiz.criteria.length === 0 && <p className="hint">바뀐 조건으로 재평가하려면 먼저 <button type="button" className="btn btn-ghost" onClick={() => go('/wizard')}>평가 조건 설정</button>을 해 주세요.</p>}
      </section>

      {(active || timeline.length > 0) && (
        <section className="card stack" aria-label="진행 상황">
          <h2>진행 단계 {active && !connected && <span className="hint">(재연결 중…)</span>}</h2>
          {active && !connected && <div className="row wrap"><p className="hint" role="status">연결이 돌아오면 자동으로 이어져요. 현재 상태를 직접 확인할 수도 있어요.</p><button type="button" className="btn" disabled={load.busy} onClick={() => void refresh()}>상태 새로고침</button></div>}
          <ol className="stages">
            {STAGES.map((s, i) => (
              <li key={s} aria-current={i === stage ? 'step' : undefined} className={i < stage ? 'done' : i === stage ? 'current' : ''}>{s}</li>
            ))}
          </ol>
          {progress && progress.total > 0 && (
            <progress max={progress.total} value={progress.done} aria-label="수집 진행">{progress.done}/{progress.total}</progress>
          )}
          <ol className="timeline" aria-live="polite">
            {timeline.slice(-40).map((t) => (
              <li key={`${t.name}:${t.seq}`}><span className="hint">#{t.seq}</span> {t.text}</li>
            ))}
          </ol>
        </section>
      )}

      {diff && (
        <section className="card stack">
          <h2>판정 변경 비교</h2>
          {diff.changes.length === 0 ? <p>바뀐 판정이 없어요.</p> : (
            <ul className="plain">
              {diff.changes.map((c) => (
                <li key={c.itemKey}>
                  <strong>{c.title ?? c.itemKey}</strong>: <DecisionBadge decision={c.before} /> → <DecisionBadge decision={c.after} />
                  {c.reason && <span className="hint"> {c.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="stack" aria-label="결과 보드">
        <div className="row wrap between">
          <h2>결과 보드</h2>
          <div className="seg" role="group" aria-label="판정 필터">
            {(['all', 'pass', 'reject', 'hold'] as const).map((f) => (
              <button key={f} type="button" className={`btn ${filter === f ? 'btn-primary' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? `전체 ${verdicts.length}` : `${DECISION_TEXT[f]} ${counts[f]}`}
              </button>
            ))}
          </div>
        </div>
        <p className="hint" role="status">{filter === 'all' ? '전체' : DECISION_TEXT[filter]} 공고 {shown.length}건{active ? ' · 평가 중인 결과는 바뀔 수 있어요.' : ''}</p>
        {shown.length === 0 && (
          <div className="card empty-state">
            <p>{verdicts.length > 0 ? '이 판정에 해당하는 공고가 없어요.' : active ? '첫 공고의 결과를 기다리고 있어요.' : '아직 확인할 공고가 없어요.'}</p>
            {filter !== 'all' ? <button type="button" className="btn" onClick={() => setFilter('all')}>전체 결과 보기</button> : !active && <button type="button" className="btn" onClick={() => go('/wizard')}>수집 설정 확인하기</button>}
          </div>
        )}
        <ul className="plain board">
          {shown.map((v) => (
            <VerdictCard key={v.itemKey} v={v} run={run} readOnly={isDemo || !!run.readOnly || active} onChanged={refresh} go={go} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function statusText(s: string): string {
  return ({ queued: '대기 중', running: '실행 중', completed: '완료', partial: '일부 완료(보류 포함)', failed: '실패', cancelled: '취소됨' } as Record<string, string>)[s] ?? s;
}

function VerdictCard({ v, run, readOnly, onChanged, go }: {
  v: Verdict; run: RunSummary; readOnly: boolean; onChanged: () => Promise<unknown>; go: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState<Decision>(v.manual?.decision ?? effective(v));
  const [note, setNote] = useState(v.manual?.note ?? '');
  const [saved, setSaved] = useState('');
  const [pending, setPending] = useState<'manual' | 'tailor' | null>(null);
  const detailId = useId();
  const titleId = useId();
  const act = useAction();
  const key = useRef(newKey());
  const dec = effective(v);
  const f = v.fields ?? {};
  useEffect(() => {
    setManual(v.manual?.decision ?? v.decision);
    setNote(v.manual?.note ?? '');
  }, [v.manual?.decision, v.manual?.note, v.decision, v.etag]);

  const saveManual = (decision: Decision | null) =>
    act.run(async () => {
      setSaved('');
      setPending('manual');
      try {
        await api.patchVerdict(run.id, v.itemKey, { decision, note }, v.etag);
        setSaved(decision === null ? '자동 판정으로 되돌렸어요.' : '수동 판정을 저장했어요.');
        await onChanged();
      } catch (e) {
        if ((e as { status?: number }).status === 412) await onChanged();
        throw e;
      } finally {
        setPending(null);
      }
    });

  const tailor = () =>
    act.run(async () => {
      setPending('tailor');
      try {
        const r = await api.startTailoring(run.id, v.itemKey, key.current);
        key.current = newKey();
        go(`/tailorings/${r.id}`);
      } finally {
        setPending(null);
      }
    });

  return (
    <li className={`card verdict verdict-${dec}`} aria-labelledby={titleId}>
      <div className="row wrap between">
        <div>
          <h3 id={titleId}>{f.title ?? v.itemKey}</h3>
          <p className="hint">{[f.company, f.location, f.experience, f.employmentType, f.deadline && `마감 ${f.deadline}`].filter(Boolean).join(' · ') || v.itemKey}</p>
        </div>
        <DecisionBadge decision={dec} manual={!!v.manual} />
      </div>
      {v.injectionSuspected && (
        <Notice kind="warn"><strong>⚠ 인젝션 경고</strong> · {HOLD_REASON_TEXT.injection_suspected}. 이 공고는 자동으로 통과하지 않아요.</Notice>
      )}
      {v.reviewChange && <p className="hint">검토 변경: {v.reviewChange.from} → {v.reviewChange.to} {v.reviewChange.reason}</p>}
      {v.holdReasons && v.holdReasons.length > 0 && (
        <ul className="reasons" aria-label="보류 사유">
          {v.holdReasons.map((r) => <li key={r}><span className="badge badge-hold">보류 사유</span> {HOLD_REASON_TEXT[r] ?? r}</li>)}
        </ul>
      )}
      <div className="row wrap">
        <button type="button" className="btn" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((o) => !o)}>
          {open ? '기준별 결과 접기' : '기준별 결과 보기'}
        </button>
        {(f.detailUrl ?? v.detailUrl) && (
          <a className="btn" href={f.detailUrl ?? v.detailUrl ?? '#'} target="_blank" rel="noopener noreferrer">원문 보기<span className="sr"> (새 탭)</span></a>
        )}
        {dec === 'pass' && !readOnly && (
          <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void tailor()}>맞춤 이력서 만들기</button>
        )}
      </div>
        <div id={detailId} className="stack" hidden={!open}>
          <ul className="plain criteria">
            {(v.criteria ?? []).map((c) => (
              <li key={c.criterionId}>
                <span className={`badge status-${c.status}`}>{{ met: '충족', not_met: '미충족', unknown: '확인 필요' }[c.status]}</span>{' '}
                <strong>{c.label ?? c.criterionId}</strong>{c.required === false && <span className="hint"> (선호)</span>}
                {c.quote && (
                  <blockquote>
                    “{c.quote}”{' '}
                    {c.quoteVerified ? <span className="badge badge-pass">원문 일치</span> : <span className="badge badge-hold">원문 불일치</span>}
                  </blockquote>
                )}
                {c.factIds && c.factIds.length > 0 && <span className="hint">사실 {c.factIds.join(', ')}</span>}
                {c.note && <p className="hint">{c.note}</p>}
              </li>
            ))}
            {(v.criteria ?? []).length === 0 && <li className="hint">기준별 결과가 아직 없어요.</li>}
          </ul>
          <p className="hint">수집 시각 {fmtTime(v.collectedAt ?? run.collectedAt)} · 계약 v{v.contractVersion ?? run.contractVersion ?? '-'}</p>
        </div>
      {!readOnly && (
        <fieldset className="manual" disabled={act.busy}>
          <legend>수동 판정</legend>
          <p className="hint">자동 판정과 다르게 판단했다면 변경 이유를 남겨 주세요.</p>
          <div className="row wrap">
            <label className="sr" htmlFor={`m-${v.itemKey}`}>수동 판정 선택</label>
            <select id={`m-${v.itemKey}`} value={manual} onChange={(e) => setManual(e.target.value as Decision)}>
              <option value="pass">통과</option><option value="reject">탈락</option><option value="hold">보류</option>
            </select>
            <input aria-label="수동 판정 메모" placeholder="메모(선택)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn" disabled={act.busy} onClick={() => void saveManual(manual)}>적용</button>
            {v.manual && <button type="button" className="btn btn-ghost" disabled={act.busy} onClick={() => void saveManual(null)}>되돌리기</button>}
          </div>
        </fieldset>
      )}
      {act.busy && <Spinner label={pending === 'tailor' ? '맞춤 이력서를 시작하는 중…' : '수동 판정을 저장하는 중…'} />}
      {saved && <Notice kind="ok">{saved}</Notice>}
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </li>
  );
}
