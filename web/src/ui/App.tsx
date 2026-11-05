import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import { postSse } from './sse';
import { useHashRoute, usePersisted } from './hooks';
import { DEMO_CRITERIA_TEXT, Notice, Spinner, initialWizard, useAction, type WizardState } from './common';
import { ChartBar, ChatCircleText, CursorClick, House, MagicWand, SquaresFour, Moon, Sun, TreeStructure } from '@phosphor-icons/react';
import { Button, UiIcon } from './design/primitives';
import { Wizard } from './Wizard';
import { RunView } from './RunView';
import { TailoringView } from './TailoringView';

// 확장 지점: Workflow 스튜디오(/studio)는 별도 모듈에서 지연 로드한다.
const Studio = lazy(() => import('./studio/Studio'));

export function App() {
  const [route, go] = useHashRoute();
  const [wiz, setWiz] = usePersisted<WizardState>('bangji.wizard', initialWizard);
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = usePersisted<ChatState>('bangji.assistantChat', emptyChat);
  const mainRef = useRef<HTMLElement>(null);
  const previousRoute = useRef(route);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('bangji.theme') === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      localStorage.setItem('bangji.theme', next);
      return next;
    });

  const path = route.split('?')[0];
  const parts = path.split('/').filter(Boolean);
  useEffect(() => {
    if (previousRoute.current !== route) {
      mainRef.current?.focus();
      window.scrollTo({ top: 0 });
      previousRoute.current = route;
    }
  }, [route]);

  const closeAssistant = useCallback(() => setChatOpen(false), []);
  const resetAssistant = useCallback(() => { setChatOpen(false); setChat(emptyChat); }, [setChat]);

  let page;
  if (parts[0] === 'wizard') page = <Wizard wiz={wiz} setWiz={setWiz} go={go} />;
  else if (parts[0] === 'runs' && parts[1]) page = <RunView key={parts[1]} runId={parts[1]} go={go} wiz={wiz} />;
  else if (parts[0] === 'demo') page = <RunView key="demo" runId="demo" go={go} wiz={wiz} />;
  else if (parts[0] === 'tailorings' && parts[1]) page = <TailoringView key={parts[1]} id={parts[1]} go={go} />;
  else if (parts[0] === 'studio') page = <Suspense fallback={<Spinner label="스튜디오를 불러오는 중…" />}><Studio /></Suspense>;
  else if (parts[0] === 'workflow') page = <WorkflowView />;
  else page = <Home go={go} wiz={wiz} setWiz={setWiz} onOpenAssistant={() => setChatOpen(true)} onDelete={resetAssistant} />;

  const nav = [
    { href: '#/', label: '홈', icon: House, active: !parts[0] },
    { href: '#/wizard', label: '설정 마법사', icon: MagicWand, active: parts[0] === 'wizard' },
    { href: '#/demo', label: '데모 결과', icon: ChartBar, active: parts[0] === 'demo' },
    { href: '#/studio', label: 'Workflow 스튜디오', icon: TreeStructure, active: parts[0] === 'studio' },
    { href: '#/workflow', label: '워크플로', icon: TreeStructure, active: parts[0] === 'workflow' },
  ];

  return (
    <div className="app">
      <a className="skip" href="#main" onClick={(event) => {
        event.preventDefault();
        mainRef.current?.focus();
        mainRef.current?.scrollIntoView({ block: 'start' });
      }}>본문으로 건너뛰기</a>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="방지리 홈">
          <span className="brand-mark" aria-hidden="true">방</span>
          <span className="brand-text">방지리</span>
        </a>
        <nav className="nav" aria-label="주요 메뉴">
          {nav.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.active ? 'page' : undefined}>
              <UiIcon icon={n.icon} size={16} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="topbar-actions">
          <Button icon={theme === 'dark' ? Sun : Moon} onClick={toggleTheme} aria-label={theme === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환'} title={theme === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환'} />
          <Button icon={ChatCircleText} onClick={() => setChatOpen((o) => !o)} aria-expanded={chatOpen} aria-controls={chatOpen ? 'design-assistant' : undefined}>
            설계 도우미
          </Button>
        </div>
      </header>
      <main ref={mainRef} id="main" className="container" tabIndex={-1}>{page}</main>
      {chatOpen && <AssistantPanel wiz={wiz} setWiz={setWiz} chat={chat} setChat={setChat} onClose={closeAssistant} />}
      <footer className="footer">
        <span><span className="statusbar__dot" aria-hidden="true" />게스트 워크스페이스</span>
        <span>AI가 보조하지만 판정과 내보내기는 코드가 검증합니다. 지원은 원 사이트에서 직접 해 주세요.</span>
      </footer>
    </div>
  );
}

function Home({ go, wiz, setWiz, onOpenAssistant, onDelete }: { go: (to: string) => void; wiz: WizardState; setWiz: (v: WizardState) => void; onOpenAssistant: () => void; onDelete: () => void }) {
  const { busy, error, run } = useAction();
  const [deleted, setDeleted] = useState(false);
  const [action, setAction] = useState<'start' | 'delete'>('start');
  const hasDraft = !!(wiz.url || wiz.browserSessionId || wiz.contractId || wiz.criteriaText || wiz.criteria.length || wiz.resumeId);

  const start = (demo: boolean) =>
    run(async () => {
      if (hasDraft && !window.confirm('새로 시작하면 작성 중인 설정이 바뀝니다. 기존 설정 대신 새로 시작할까요?')) return;
      setAction('start');
      await api.guest();
      setDeleted(false);
      setWiz(
        demo
          ? { ...initialWizard, sourceKind: 'demo', criteriaText: DEMO_CRITERIA_TEXT }
          : { ...initialWizard, sourceKind: 'url' },
      );
      go('/wizard');
    });

  const remove = () =>
    run(async () => {
      if (!window.confirm('이 브라우저의 워크스페이스와 모든 데이터를 삭제할까요?')) return;
      setAction('delete');
      await api.deleteWorkspace();
      setWiz(initialWizard);
      sessionStorage.removeItem('bangji.assistantChat');
      onDelete();
      setDeleted(true);
    });

  return (
    <div className="stack">
      <section className="hero">
        <h1>반복되는 선별 업무, 기준만 정하면 자동으로</h1>
        <p>채용 공고를 모아 내 조건으로 선별하고, 근거를 검토한 뒤 맞춤 이력서를 만들어요.</p>
        <p className="hint">수집처 선택 → 조건·이력서 확인 → 결과 검토 → 맞춤 이력서 내보내기</p>
        {busy && <Spinner label={action === 'delete' ? '내 데이터를 삭제하는 중…' : '워크스페이스를 만드는 중…'} />}
        {error && <Notice kind="error">{error}</Notice>}
        {deleted && <Notice kind="ok">내 데이터를 삭제했어요.</Notice>}
      </section>

      {hasDraft && (
        <section className="card stack" aria-labelledby="continue-heading">
          <h2 id="continue-heading">작성 중인 설정이 있어요</h2>
          <p>이 탭에 저장된 수집처와 조건을 이어서 확인하세요. 새로 시작하면 현재 설정이 바뀌어요.</p>
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={() => go('/wizard')} disabled={busy}>이어서 설정하기</button>
          </div>
        </section>
      )}

      <section aria-label="시작 방법">
        <div className="grid3">
          <article className="card start-card">
            <UiIcon icon={SquaresFour} size={20} />
            <h2>처음이라면 데모로 체험</h2>
            <p>검증된 예시 흐름을 그대로 실행하며 전체 과정을 체험해요.</p>
            <div className="row wrap">
              <button type="button" className={hasDraft ? 'btn' : 'btn btn-primary'} onClick={() => start(true)} disabled={busy}>
                데모로 바로 시작
              </button>
              <button type="button" className="btn" onClick={() => go('/demo')}>
                데모 결과 보기
              </button>
            </div>
          </article>
          <article className="card start-card">
            <UiIcon icon={CursorClick} size={20} />
            <h2>내 채용 게시판 연결</h2>
            <p>수집할 웹 페이지를 열고, 화면에서 목록과 항목을 직접 짚어 지정해요.</p>
            <div className="row wrap">
              <button type="button" className="btn" onClick={() => start(false)} disabled={busy}>
                내 수집처로 시작
              </button>
            </div>
          </article>
          <article className="card start-card">
            <UiIcon icon={ChatCircleText} size={20} />
            <h2>설정이 막힐 때 도움받기</h2>
            <p>수집처 화면을 불러온 뒤, 도우미에게 영역 선택과 조건 작성 방법을 물어보세요.</p>
            <div className="row wrap">
              <button type="button" className="btn btn-ghost" onClick={onOpenAssistant} disabled={busy}>
                설계 도우미 열기
              </button>
            </div>
          </article>
        </div>
      </section>

      <section aria-labelledby="tpl">
        <h2 id="tpl">템플릿 둘러보기</h2>
        <div className="grid3">
          <article className="card">
            <h3>채용 공고 스크리닝 (예시)</h3>
            <p>수집 → 기준 평가 → 사람 검토 → 후속 산출물까지. 데모로 전체 흐름을 체험해 보세요.</p>
            <span className="badge badge-pass">사용 가능</span>
          </article>
          <article className="card card-disabled" aria-disabled="true">
            <h3>상품·매물 모니터링</h3>
            <p>가격, 재고, 조건에 맞는 항목만 추려 냅니다.</p>
            <span className="badge">준비 중</span>
          </article>
          <article className="card card-disabled" aria-disabled="true">
            <h3>공모·입찰·규정 검토</h3>
            <p>마감과 자격 요건을 근거와 함께 확인합니다.</p>
            <span className="badge">준비 중</span>
          </article>
        </div>
      </section>

      <section className="card">
        <h2>내 데이터</h2>
        <p>게스트 데이터는 7일 뒤 자동으로 삭제됩니다. 지금 바로 지울 수도 있어요.</p>
        <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
          내 데이터 삭제
        </button>
      </section>
    </div>
  );
}

function WorkflowView() {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(() => run(async () => setText(await api.workflowGraph())), [run]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="stack">
      <h1>워크플로 그래프</h1>
      <p>평가 워크플로의 Mermaid 텍스트입니다. 편집기나 Mermaid Live에 붙여 넣으면 그림으로 볼 수 있어요.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {error && text === null && <button type="button" className="btn" disabled={busy} onClick={() => void load()}>다시 불러오기</button>}
      {text === null && !error && <Spinner label="불러오는 중…" />}
      {text !== null && (
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
            setCopied(false);
            if (!navigator.clipboard) throw new Error('이 브라우저에서는 자동 복사를 사용할 수 없어요. 아래 텍스트를 선택해 복사해 주세요.');
            await navigator.clipboard.writeText(text);
            setCopied(true);
          })}>
            복사
          </button>
          {copied && <Notice kind="ok">워크플로 텍스트를 복사했어요.</Notice>}
          <pre className="code" tabIndex={0} aria-label="Mermaid 텍스트">{text}</pre>
        </>
      )}
    </div>
  );
}

export interface ChatMsg { role: 'user' | 'assistant'; text: string; note?: string; draft?: unknown }
export interface ChatState { sessionId: string | null; sessionBrowserId: string | null; ownBrowserId: string | null; msgs: ChatMsg[] }
export const emptyChat: ChatState = { sessionId: null, sessionBrowserId: null, ownBrowserId: null, msgs: [] };

function AssistantPanel({ onClose, wiz, setWiz, chat, setChat }: {
  onClose: () => void;
  wiz: WizardState;
  setWiz: (v: WizardState | ((p: WizardState) => WizardState)) => void;
  chat: ChatState;
  setChat: (v: ChatState | ((p: ChatState) => ChatState)) => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [panelUrl, setPanelUrl] = useState(wiz.url);
  const endRef = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const msgs = chat.msgs;
  const browserSessionId = wiz.browserSessionId ?? chat.ownBrowserId ?? undefined;

  useEffect(() => {
    const trigger = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const patchLast = (fn: (m: ChatMsg) => ChatMsg) =>
    setChat((c) => {
      const copy = c.msgs.slice();
      if (copy.length) copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return { ...c, msgs: copy };
    });

  const urlOk = (() => {
    try { return ['http:', 'https:'].includes(new URL(panelUrl.trim()).protocol); } catch { return false; }
  })();
  const needsUrl = !browserSessionId && wiz.sourceKind !== 'demo';

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (needsUrl && !urlOk) {
      setError('수집처 URL(http:// 또는 https://)을 입력해 주세요.');
      return;
    }
    setInput('');
    setError(null);
    setBusy(true);
    setChat((c) => ({ ...c, msgs: [...c.msgs, { role: 'user', text }, { role: 'assistant', text: '' }] }));
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      let bsid = browserSessionId;
      if (!bsid) {
        setProgress('수집처 화면을 여는 중…');
        await api.guest();
        const b = await api.startBrowser(wiz.sourceKind === 'demo' ? { kind: 'demo' } : { kind: 'url', url: panelUrl.trim() });
        bsid = b.id;
        setChat((c) => ({ ...c, ownBrowserId: b.id }));
      }
      let id = chat.sessionBrowserId === bsid ? chat.sessionId : null;
      if (!id) {
        setProgress('도우미 세션을 만드는 중…');
        id = (await api.startAssistant(bsid)).assistantSessionId;
        const sid = id;
        const used = bsid;
        setChat((c) => ({ ...c, sessionId: sid, sessionBrowserId: used }));
      }
      setProgress('응답을 기다리는 중…');
      await postSse(
        `/api/assistant/sessions/${id}/messages`,
        { message: text },
        (m) => {
          const d = m.data as { text?: string; message?: string; draft?: unknown; draftError?: unknown } | string;
          if (m.event === 'assistant.failed') {
            setError(typeof d === 'string' ? d : (d?.message ?? '도우미가 응답하지 못했어요'));
            setInput(text);
            return;
          }
          if (m.event === 'assistant.completed') {
            const obj = typeof d === 'string' ? { text: d } : (d ?? {});
            const full = obj.text ?? '';
            const draft = obj.draft ?? undefined;
            const note = draft ? undefined : obj.draftError ? '대화만 완료됐고 구조화 초안을 만들지 못했어요.' : '대화 응답만 있어요(초안 없음).';
            patchLast((last) => ({ ...last, text: last.text || full, draft, note }));
            return;
          }
          const piece = typeof d === 'string' ? d : (d?.text ?? '');
          if (m.event === 'assistant.delta' && piece) patchLast((last) => ({ ...last, text: last.text + piece }));
        },
        ctl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(errorMessage(e));
        setInput(text);
        if ((e as { status?: number }).status === 404) setChat((c) => ({ ...c, sessionId: null, sessionBrowserId: null }));
      }
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, [input, busy, browserSessionId, needsUrl, urlOk, panelUrl, wiz.sourceKind, chat.sessionId, chat.sessionBrowserId, setChat]);

  const applyDraft = (draft: unknown) => {
    // 수집 단계에 직접 적용하는 핸들러가 아직 없어 마법사 첫 단계로 이동해 초안을 참고하게 한다.
    setWiz((w) => ({ ...w, step: 1 }));
    window.location.hash = '/wizard';
    onClose();
    void draft;
  };

  return (
    <aside ref={panelRef} id="design-assistant" className="chat" role="dialog" aria-label="설계 도우미" tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }}>
      <div className="chat-head">
        <strong>설계 도우미</strong>
        <div className="row">
          {msgs.length > 0 && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setChat(emptyChat)}>대화 지우기</button>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>닫기</button>
        </div>
      </div>
      <div className="chat-body" aria-live="polite">
        {msgs.length === 0 && (
          <p className="hint">
            {browserSessionId
              ? '조건을 어떻게 쓸지, 어떤 영역을 고를지 물어보세요.'
              : wiz.sourceKind === 'demo'
                ? '메시지를 보내면 데모 수집처 화면을 자동으로 열고 답해요.'
                : '수집처 URL을 입력하고 메시지를 보내면 화면을 자동으로 열고 답해요.'}
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble bubble-${m.role}`}>
            {m.text || (busy && i === msgs.length - 1 ? '응답을 작성하는 중…' : '응답을 받지 못했어요. 메시지를 다시 보내 주세요.')}
            {m.role === 'assistant' && m.note && <p className="hint">{m.note}</p>}
            {m.draft != null && (
              <div className="card card-inner stack">
                <strong>설정 초안</strong>
                <pre className="code" tabIndex={0} aria-label="설정 초안 JSON">{JSON.stringify(m.draft, null, 2)}</pre>
                <div className="row wrap">
                  <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(m.draft, null, 2)).then(() => setCopied(i))}>복사</button>
                  <button type="button" className="btn btn-primary" onClick={() => applyDraft(m.draft)}>초안 적용</button>
                </div>
                {copied === i && <span className="hint" role="status">복사했어요.</span>}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {progress && <Spinner label={progress} />}
      {error && <Notice kind="error">{error}</Notice>}
      {needsUrl && (
        <label className="field">
          <span className="field-label">수집처 URL</span>
          <input type="url" value={panelUrl} placeholder="https://example.com/jobs" disabled={busy} onChange={(e) => setPanelUrl(e.target.value)} />
        </label>
      )}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="메시지를 입력하세요"
          aria-label="도우미에게 보낼 메시지"
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>보내기</button>
      </form>
    </aside>
  );
}
