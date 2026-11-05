import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type CriteriaCard, type Fact, type Resume } from './api';
import { postSse, type SseMessage } from './sse';
import { newKey } from './hooks';
import {
  DEMO_CRITERIA_TEXT, Field, Notice, Spinner, useAction, type WizardState,
} from './common';
import { CollectStep } from './CollectStep';

const STEPS = ['수집처·영역', '조건', '이력서', '실행'];
const CHIPS = ['마감 안 된 공고', '경력 3년으로 지원 가능', '서울·경기 또는 원격', '정규직', '백엔드·Node.js'];
const KIND_LABEL: Record<CriteriaCard['kind'], string> = {
  deadline: '마감일',
  experience: '경력 연수',
  location: '지역',
  employmentType: '고용형태',
  semantic: '의미(직무·기술 적합도)',
};

type SetWiz = (v: WizardState | ((p: WizardState) => WizardState)) => void;
type StepProps = { wiz: WizardState; setWiz: SetWiz; onBusyChange: (busy: boolean) => void };
const validCriteria = (cards: CriteriaCard[]) => cards.length > 0 && cards.every((c) => c.label.trim() && c.value.trim());

export function Wizard({ wiz, setWiz, go }: { wiz: WizardState; setWiz: SetWiz; go: (to: string) => void }) {
  const [busySteps, setBusySteps] = useState<Record<string, boolean>>({});
  const collectBusy = useCallback((busy: boolean) => setBusySteps((p) => ({ ...p, collect: busy })), []);
  const criteriaBusy = useCallback((busy: boolean) => setBusySteps((p) => ({ ...p, criteria: busy })), []);
  const resumeBusy = useCallback((busy: boolean) => setBusySteps((p) => ({ ...p, resume: busy })), []);
  const runBusy = useCallback((busy: boolean) => setBusySteps((p) => ({ ...p, run: busy })), []);
  const busy = Object.values(busySteps).some(Boolean);
  const collected = !!wiz.contractId;
  const criteriaReady = collected && validCriteria(wiz.criteria);
  const resumeReady = criteriaReady && !!wiz.resumeId && !!wiz.resumeConfirmed;
  const maxStep = !collected ? 2 : !criteriaReady ? 3 : !resumeReady ? 4 : 5;
  const stepIndex = Math.min(Math.max(wiz.step, 1), maxStep);
  const ui = stepIndex <= 2 ? 1 : stepIndex - 1;
  const goStep = (n: number) => { if (!busy) setWiz((w) => ({ ...w, step: n })); };
  const canGo = (i: number) =>
    i === 0 || (i === 1 && collected) || (i === 2 && criteriaReady) || (i === 3 && resumeReady);
  const complete = [collected, criteriaReady, resumeReady, false];
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wiz.step !== stepIndex) setWiz((w) => ({ ...w, step: stepIndex }));
  }, [wiz.step, stepIndex, setWiz]);
  useEffect(() => {
    const heading = root.current?.querySelector<HTMLElement>('[data-wizard-panel]:not([hidden]) h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }, [stepIndex]);
  return (
    <div className="stack" ref={root}>
      <h1>설정 마법사</h1>
      <p className="hint wizard-progress">4단계 중 {ui}단계 · {STEPS[ui - 1]}. 설정을 확인한 뒤 마지막 단계에서 실행해요.</p>
      <ol className="steps" aria-label="진행 단계">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const target = [1, 3, 4, 5][i];
          return (
            <li key={s} className={n === ui ? 'current' : complete[i] ? 'done' : ''} aria-current={n === ui ? 'step' : undefined}>
              <button type="button" className="step-btn" disabled={busy || !canGo(i)} onClick={() => goStep(target)}>
                <span className="step-num">{n}</span> {s}
                {complete[i] && <span className="sr"> 완료</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {busy && <p className="hint" role="status">처리가 끝나면 다른 단계로 이동할 수 있어요.</p>}
      <div data-wizard-panel hidden={stepIndex > 2}>
          <CollectStep wiz={wiz} setWiz={setWiz} onBusyChange={collectBusy} />
          {wiz.contractId && (
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => goStep(3)}>조건 설정하기</button>
            </div>
          )}
      </div>
      <div data-wizard-panel hidden={stepIndex !== 3}><CriteriaStep wiz={wiz} setWiz={setWiz} onBusyChange={criteriaBusy} /></div>
      <div data-wizard-panel hidden={stepIndex !== 4}><ResumeStep wiz={wiz} setWiz={setWiz} onBusyChange={resumeBusy} active={stepIndex === 4} /></div>
      {stepIndex === 5 && <div data-wizard-panel><RunStep wiz={wiz} setWiz={setWiz} go={go} onBusyChange={runBusy} /></div>}
    </div>
  );
}

// ---------------- 조건 ----------------
function CriteriaStep({ wiz, setWiz, onBusyChange }: StepProps) {
  const [streamText, setStreamText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  const setCards = (fn: (c: CriteriaCard[]) => CriteriaCard[]) => setWiz((w) => ({ ...w, criteria: fn(w.criteria) }));

  const draft = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    setStreamText('');
    setWiz((w) => ({ ...w, criteria: [] }));
    let received = false;
    const ctl = new AbortController();
    abort.current = ctl;
    const onMsg = (m: SseMessage) => {
      const d = m.data as any;
      if (m.event === 'assistant.delta') {
        const piece = typeof d === 'string' ? d : (d?.text ?? '');
        setStreamText((t) => t + piece);
        return;
      }
      if (m.event === 'error' || m.event === 'criteria.failed') {
        setError(`${d?.message ?? '조건 분리에 실패했어요.'} 아래에서 카드를 직접 추가해 주세요.`);
        return;
      }
      if (m.event === 'criteria.draft') {
        received = true;
        const cards = [...(d?.ruleCards ?? []), ...(d?.semanticCards ?? [])].map(fromServerCard);
        setWiz((w) => ({ ...w, criteria: cards }));
      }
    };
    try {
      await postSse('/api/criteria/draft', { text }, onMsg, ctl.signal);
      if (!received) setError('조건 카드를 받지 못했어요. 다시 나누거나 아래에서 직접 추가해 주세요.');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(`${errorMessage(e)} 아래에서 카드를 직접 입력할 수 있어요.`);
    } finally {
      setBusy(false);
    }
  };

  const addCard = (gate: 'rule' | 'semantic', kind: CriteriaCard['kind']) =>
    setCards((c) => [...c, { id: newKey(), gate, kind, label: KIND_LABEL[kind], value: '', required: true }]);

  return (
    <fieldset className="wizard-panel stack" disabled={busy} aria-busy={busy}>
      <section className="card stack">
        <h2>조건 입력</h2>
        <p className="hint">조건을 카드로 나눈 뒤 이름과 값을 확인해 주세요. 입력 문장을 바꾸면 기존 카드는 다시 만들어야 해요.</p>
        <Field label="선별 기준을 자유롭게 적어 주세요(예시는 채용 공고 기준이에요)">
          <textarea
            rows={3}
            value={wiz.criteriaText}
            onChange={(e) => setWiz((w) => ({ ...w, criteriaText: e.target.value, criteria: [] }))}
            placeholder="예: 마감 안 된 공고, 경력 3년으로 지원 가능, 서울·경기 또는 원격, 정규직, 백엔드·Node.js"
          />
        </Field>
        <div className="row wrap" aria-label="예시 칩">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              className="chip"
              onClick={() => setWiz((w) => ({ ...w, criteriaText: w.criteriaText ? `${w.criteriaText}, ${c}` : c, criteria: [] }))}
            >
              + {c}
            </button>
          ))}
        </div>
        <div className="row wrap flow-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setWiz((w) => ({ ...w, criteriaText: DEMO_CRITERIA_TEXT }));
              void draft(DEMO_CRITERIA_TEXT);
            }}
          >
            데모 프리셋 적용
          </button>
          <button type="button" className={`btn ${validCriteria(wiz.criteria) ? '' : 'btn-primary'}`} disabled={busy || !wiz.criteriaText.trim()} onClick={() => void draft(wiz.criteriaText)}>
            조건 나누기
          </button>
          {busy && <Spinner label="AI가 조건을 나누는 중…" />}
        </div>
        {busy && streamText && <pre className="stream" aria-live="polite">{streamText}</pre>}
        {error && <Notice kind="error">{error}</Notice>}
      </section>

      <section className="card stack">
        <h2>규칙 Gate · 의미 Gate 카드</h2>
        <p className="hint">값과 필수·선호를 고칠 수 있어요. 선호 기준은 판정에 영향을 주지 않고 참고로만 표시돼요.</p>
        {wiz.criteria.length === 0 && <p className="hint">아직 카드가 없어요. 조건을 나누거나 직접 추가하세요.</p>}
        <ul className="plain stack">
          {wiz.criteria.map((c) => (
            <li key={c.id} className="card card-inner">
              <div className="row wrap between">
                <strong>{c.gate === 'rule' ? '규칙 Gate' : '의미 Gate'} · {KIND_LABEL[c.kind] ?? c.kind}</strong>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`${c.label} 카드 삭제`}
                  onClick={() => setCards((all) => all.filter((x) => x.id !== c.id))}
                >
                  삭제
                </button>
              </div>
              <Field label="이름" error={!c.label.trim() ? '조건을 구분할 이름을 입력해 주세요.' : undefined}>
                <input value={c.label} onChange={(e) => setCards((all) => all.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)))} />
              </Field>
              <Field label="값" error={!c.value.trim() ? '평가에 사용할 조건 값을 입력하거나 카드를 삭제해 주세요.' : undefined}>
                <input
                  value={c.value}
                  placeholder={c.kind === 'experience' ? '예: 3년' : c.kind === 'semantic' ? '예: 백엔드 개발자, Node.js' : ''}
                  onChange={(e) => setCards((all) => all.map((x) => (x.id === c.id ? { ...x, value: e.target.value } : x)))}
                />
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={c.required}
                  onChange={(e) => setCards((all) => all.map((x) => (x.id === c.id ? { ...x, required: e.target.checked } : x)))}
                />
                필수 (해제하면 선호)
              </label>
            </li>
          ))}
        </ul>
        {!validCriteria(wiz.criteria) && <p className="hint" role="status">이름과 값이 있는 조건 카드를 하나 이상 준비하면 다음 단계로 이동할 수 있어요.</p>}
        <div className="row wrap flow-actions">
          <span>카드 추가:</span>
          {(['deadline', 'experience', 'location', 'employmentType'] as const).map((k) => (
            <button key={k} type="button" className="btn" onClick={() => addCard('rule', k)}>{KIND_LABEL[k]}</button>
          ))}
          <button type="button" className="btn" onClick={() => addCard('semantic', 'semantic')}>의미 기준</button>
        </div>
      </section>

      <div className="row wrap">
        <button type="button" className="btn" onClick={() => setWiz((w) => ({ ...w, step: 1 }))}>이전</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !validCriteria(wiz.criteria)}
          onClick={() => setWiz((w) => ({ ...w, step: 4 }))}
        >
          이력서 확인하기
        </button>
      </div>
    </fieldset>
  );
}

const RULE_KIND: Record<string, CriteriaCard['kind']> = {
  deadline: 'deadline',
  experience: 'experience',
  region: 'location',
  employment: 'employmentType',
};

/** 서버의 ruleCards/semanticCards를 UI 카드(gate/kind/label/value)로 바꾼다. */
function fromServerCard(c: any): CriteriaCard {
  if (c.kind === 'semantic') {
    return { id: String(c.id), gate: 'semantic', kind: 'semantic', label: KIND_LABEL.semantic, value: c.text ?? '', required: c.required !== false };
  }
  const p = c.params ?? {};
  const kind = RULE_KIND[c.criterion] ?? 'semantic';
  let value = '';
  if (kind === 'experience') {
    value = p.minYears != null || p.maxYears != null
      ? [p.minYears != null ? `${p.minYears}년 이상` : '', p.maxYears != null ? `${p.maxYears}년 이하` : ''].filter(Boolean).join(' ')
      : p.myYears != null ? `${p.myYears}년` : '';
  } else if (kind === 'location') {
    value = [...(p.allowedRegions ?? []), ...(p.allowRemote ? ['원격'] : [])].join(', ');
  } else if (kind === 'employmentType') {
    value = (p.employmentTypes ?? []).join(', ');
  } else if (kind === 'deadline') {
    value = p.notPast === false ? '' : '마감 전';
  }
  return { id: String(c.id), gate: 'rule', kind, label: c.label ?? KIND_LABEL[kind], value, required: c.required !== false };
}

// ---------------- 이력서 ----------------
function ResumeStep({ wiz, setWiz, onBusyChange, active }: StepProps & { active: boolean }) {
  const [text, setText] = useState('');
  const [consent, setConsent] = useState(false);
  const [resume, setResume] = useState<Resume | null>(() =>
    wiz.resumeFacts && wiz.resumeFacts.resumeId === wiz.resumeId ? { ...wiz.resumeFacts, facts: wiz.resumeFacts.facts } as Resume : null);
  useEffect(() => {
    setWiz((w) => ({
      ...w,
      resumeFacts: resume ? { resumeId: resume.resumeId, facts: resume.facts, etag: resume.etag, experienceYears: resume.experienceYears } : undefined,
    }));
  }, [resume, setWiz]);
  const [streamText, setStreamText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAction();
  const restore = useAction();
  const restoreAttempt = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const working = busy || save.busy || restore.busy;
  useEffect(() => { onBusyChange(working); return () => onBusyChange(false); }, [working, onBusyChange]);

  const restoreResume = () => restore.run(async () => {
    if (!wiz.resumeId) return;
    try {
      const response = await fetch(`/api/resumes/${encodeURIComponent(wiz.resumeId)}`, { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? '저장된 이력서를 불러오지 못했어요. 다시 불러오거나 새 이력서를 사용해 주세요.');
      setResume({ ...data, experienceYears: data.careerYears, etag: data.etag ?? response.headers.get('ETag')?.replace(/^W\/|"/g, '') });
      if (!data.facts?.length || data.facts.some((f: Fact) => !f.confirmed || !f.text.trim())) {
        setWiz((w) => ({ ...w, resumeConfirmed: false }));
      }
      save.setError(null);
    } catch (e) {
      setWiz((w) => ({ ...w, resumeConfirmed: false }));
      throw e;
    }
  });
  useEffect(() => {
    if (active && wiz.resumeId && !resume && restoreAttempt.current !== wiz.resumeId) {
      restoreAttempt.current = wiz.resumeId;
      void restoreResume();
    }
  }, [active, wiz.resumeId, resume]);

  const submit = async (sample: boolean) => {
    if (working || (!sample && (!consent || !text.trim()))) return;
    setBusy(true);
    setError(null);
    setStreamText('');
    setResume(null);
    save.setError(null);
    restore.setError(null);
    setWiz((w) => ({ ...w, resumeId: undefined, resumeConfirmed: false }));
    const ctl = new AbortController();
    abort.current = ctl;
    let received = false;
    try {
      await postSse(
        '/api/resumes',
        sample ? { sample: true, consent: true } : { text, consent: true },
        (m) => {
          const d = m.data as any;
          if (m.event === 'assistant.delta') {
            setStreamText((t) => t + (typeof d === 'string' ? d : (d?.text ?? '')));
          } else if (m.event === 'resume.sentences') {
            setResume((r) => ({ ...(r ?? { resumeId: d.resumeId, facts: [] }), resumeId: d.resumeId, sentences: d.sentences }));
          } else if (m.event === 'resume.facts') {
            received = true;
            const r: Resume = {
              resumeId: d.resumeId,
              facts: d.facts ?? [],
              sentences: d.sentences,
              experienceYears: d.careerYears,
              etag: d.etag,
              manual: !!d.manual,
            };
            setResume(r);
            setWiz((w) => ({ ...w, resumeId: r.resumeId }));
            if (d.manual) setError(`${d.error?.message ?? '사실을 구조화하지 못했어요.'} 사실을 직접 추가해 주세요.`);
          } else if (m.event === 'resume.failed' || m.event === 'error') {
            setResume(null);
            setWiz((w) => ({ ...w, resumeId: undefined, resumeConfirmed: false }));
            setError(d?.message ?? '이력서를 구조화하지 못했어요.');
          }
        },
        ctl.signal,
      );
      if (!received) {
        setResume(null);
        setError('저장된 사실 목록을 받지 못했어요. 이력서를 다시 사용해 주세요.');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const editFacts = (update: (facts: Fact[]) => Fact[]) => {
    setWiz((w) => ({ ...w, resumeConfirmed: false }));
    save.setError(null);
    setResume((r) => r ? { ...r, facts: update(r.facts) } : r);
  };
  const setFact = (id: string, patch: Partial<Fact>) =>
    editFacts((facts) => facts.map((f) => f.id === id ? { ...f, ...patch, origin: 'user', confirmed: false } : f));

  const confirm = () =>
    save.run(async () => {
      if (working || !resume?.etag || !resume.facts.length || resume.facts.some((f) => !f.text.trim() || f.text.length > 400)) return;
      const { data, etag } = await api.putFacts(
        resume.resumeId,
        resume.facts.map((f) => ({ ...f, confirmed: true, needsCheck: false })),
        resume.etag,
      );
      setResume({ ...resume, facts: data?.facts ?? resume.facts, etag: data?.etag ?? etag?.replace(/^W\/|"/g, '') ?? resume.etag });
      setWiz((w) => ({ ...w, resumeId: resume.resumeId, resumeConfirmed: true, step: 5 }));
    });

  return (
    <fieldset className="wizard-panel stack" disabled={working} aria-busy={working}>
      <section className="card stack">
        <h2>이력서</h2>
        <div className="row wrap">
          <button type="button" className={`btn ${!resume && !text.trim() ? 'btn-primary' : ''}`} disabled={working} onClick={() => void submit(true)}>
            샘플 이력서 사용
          </button>
        </div>
        <p className="hint">샘플 사용 버튼을 누르면 가상 이력서를 AI 모델로 보내 사실 목록을 만들어요.</p>
        <p className="hint">또는 내 이력서를 붙여 넣으세요(최대 8,000자). 전화번호·이메일은 모델 전송 전에 [연락처]로 가려져요.</p>
        <Field label="이력서 텍스트">
          <textarea rows={6} maxLength={8000} value={text} onChange={(e) => {
            setText(e.target.value);
            setResume(null);
            setWiz((w) => ({ ...w, resumeId: undefined, resumeConfirmed: false }));
          }} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          이력서 내용이 AI 모델로 전송되는 것에 동의합니다.
        </label>
        <div className="row wrap">
          <button type="button" className={`btn ${!resume && text.trim() ? 'btn-primary' : ''}`} disabled={working || !consent || !text.trim()} onClick={() => void submit(false)}>
            붙여넣은 이력서 사용
          </button>
          {busy && <Spinner label="사실 목록을 만드는 중…" />}
        </div>
        {!resume && !working && <p className="hint">샘플을 사용하거나, 이력서를 입력하고 모델 전송에 동의해 주세요.</p>}
        {restore.busy && <Spinner label="저장된 이력서를 불러오는 중…" />}
        {restore.error && <Notice kind="error">{restore.error}</Notice>}
        {restore.error && <button type="button" className="btn" onClick={() => void restoreResume()}>저장된 이력서 다시 불러오기</button>}
        {busy && streamText && <pre className="stream" aria-live="polite">{streamText}</pre>}
        {error && <Notice kind="error">{error}</Notice>}
      </section>

      {resume && (
        <section className="card stack">
          <h2>사실 목록 확인</h2>
          <p className="hint">
            확인한 사실만 평가와 맞춤 이력서에 쓰여요.
            {resume.experienceYears != null && ` 계산된 총 경력: ${resume.experienceYears}년`}
          </p>
          {resume.facts.length === 0 && <Notice kind="warn">확인할 사실이 없어요. 원문에 있는 경력·기술을 사실 추가 버튼으로 입력해 주세요.</Notice>}
          {resume.facts.some((f) => !f.text.trim()) && <p className="hint" role="status">비어 있는 사실을 입력하거나 삭제하면 확인을 완료할 수 있어요.</p>}
          <ul className="plain stack">
            {resume.facts.map((f) => (
              <li key={f.id} className="card card-inner">
                <div className="row wrap between">
                  <strong>{f.id} · {f.category}</strong>
                  <span>
                    {f.needsCheck && <span className="badge badge-hold">확인 필요</span>}
                    {f.origin === 'user' && <span className="badge">사용자 추가</span>}
                  </span>
                </div>
                <Field label={`${f.id} 내용`} hint={f.sourceSpan ? `원문: ${f.sourceSpan}` : undefined}>
                  <textarea rows={2} maxLength={400} value={f.text} onChange={(e) => setFact(f.id, { text: e.target.value })} />
                </Field>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => editFacts((facts) => facts.filter((x) => x.id !== f.id))}
                >
                  {f.id} 삭제
                </button>
              </li>
            ))}
          </ul>
          <div className="row wrap flow-actions">
            <button
              type="button"
              className="btn"
              disabled={resume.facts.length >= 80}
              onClick={() =>
                editFacts((facts) => [...facts, { id: `U${newKey()}`, category: 'summary', text: '', sourceSpan: '', origin: 'user', skills: [], numbers: [] }])
              }
            >
              사실 추가
            </button>
            <button type="button" className="btn" onClick={() => setWiz((w) => ({ ...w, step: 3 }))}>이전</button>
            <button type="button" className="btn btn-primary" disabled={working || !resume.etag || resume.facts.some((f) => !f.text.trim() || f.text.length > 400) || resume.facts.length === 0} onClick={() => void confirm()}>
              사실 확인 완료
            </button>
            {save.busy && <Spinner label="저장 중…" />}
          </div>
          {save.error && <Notice kind="error">{save.error}</Notice>}
          {save.error && <button type="button" className="btn" onClick={() => {
            setWiz((w) => ({ ...w, resumeConfirmed: false }));
            void restoreResume();
          }}>편집 취소하고 저장된 사실 다시 불러오기</button>}
        </section>
      )}
      {!resume && (
        <div className="row"><button type="button" className="btn" onClick={() => setWiz((w) => ({ ...w, step: 3 }))}>이전</button></div>
      )}
    </fieldset>
  );
}

// ---------------- 실행 ----------------
function RunStep({ wiz, setWiz, go, onBusyChange }: StepProps & { go: (to: string) => void }) {
  const { busy, error, run } = useAction();
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const key = useRef(newKey());
  const ready = !!wiz.contractId && !!wiz.resumeId && !!wiz.resumeConfirmed && validCriteria(wiz.criteria);
  const start = () =>
    run(async () => {
      if (!ready || busy) return;
      const r = await api.startRun(
        { contractId: wiz.contractId!, contractVersion: wiz.contractVersion, criteria: wiz.criteria, resumeId: wiz.resumeId! },
        key.current,
      );
      key.current = newKey();
      go(`/runs/${r.id}`);
    });
  return (
    <section className="card stack">
      <h2>실행</h2>
      <p className="hint">아래 설정으로 목록을 수집하고 평가해요. 원 사이트에 지원하거나 이력서를 제출하지는 않아요.</p>
      <dl className="summary">
        <dt>수집처</dt><dd>{wiz.sourceKind === 'demo' ? '데모용 가상 채용 게시판' : wiz.url}</dd>
        <dt>조건 카드</dt><dd>{wiz.criteria.length}개 (필수 {wiz.criteria.filter((c) => c.required).length})</dd>
        <dt>이력서</dt><dd>{wiz.resumeConfirmed ? '사실 확인 완료' : '사실 확인 필요'}</dd>
      </dl>
      <ul className="plain criteria" aria-label="실행할 평가 조건">
        {wiz.criteria.map((card) => <li key={card.id}><strong>{card.label}</strong>: {card.value} <span className="badge">{card.required ? '필수' : '선호'}</span></li>)}
      </ul>
      {!ready && <Notice kind="warn">계약, 조건, 확인된 이력서가 모두 필요해요.</Notice>}
      <div className="row wrap flow-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => setWiz((w) => ({ ...w, step: 4 }))}>이전</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setWiz((w) => ({ ...w, step: 1 }))}>설정 다시 보기</button>
        <button type="button" className="btn btn-primary btn-lg" disabled={!ready || busy} onClick={() => void start()}>
          실행
        </button>
        {busy && <Spinner label="실행을 시작하는 중…" />}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
