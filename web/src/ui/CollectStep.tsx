import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ApiError, FIELD_LABELS, api, toSession,
  type BBox, type BrowserAction, type BrowserSession, type ContractField, type ContractPreview,
  type Recommendation,
} from './api';
import { Field, Notice, Spinner, useAction, type WizardState } from './common';

const FIELD_ORDER = ['company', 'title', 'experience', 'location', 'employmentType', 'deadline', 'detailUrl'];
const NONE = '';

export function CollectStep({
  wiz,
  setWiz,
  onBusyChange,
}: {
  wiz: WizardState;
  setWiz: (v: WizardState | ((p: WizardState) => WizardState)) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [mode, setMode] = useState<'browse' | 'select'>('browse');
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [container, setContainer] = useState<string>('');
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [structureOnly, setStructureOnly] = useState(false);
  const [preview, setPreview] = useState<ContractPreview | null>(null);
  const [fields, setFields] = useState<ContractField[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [canParent, setCanParent] = useState(true);
  const [canChild, setCanChild] = useState(true);
  const [dirty, setDirty] = useState(false);
  const load = useAction();
  const act = useAction();
  const prev = useAction();
  const save = useAction();
  const imgRef = useRef<HTMLImageElement>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [imageError, setImageError] = useState(false);
  const busy = load.busy || act.busy || prev.busy || save.busy;
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  const vw = session?.viewport?.width ?? 1280;
  const vh = session?.viewport?.height ?? 800;
  const imgSrc = session?.screenshotUrl;
  const [startUrl, setStartUrl] = useState('');
  const sourceKind = wiz.sourceKind === 'demo' ? 'demo' : 'external';
  let validUrl = false;
  try {
    const url = new URL(wiz.url.trim());
    validUrl = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && wiz.url.trim().length <= 2000;
  } catch { /* The URL field below explains how to fix invalid input. */ }
  const buildSource = () => ({
    kind: sourceKind as 'demo' | 'external',
    startUrl,
    allowedHosts: [new URL(startUrl).hostname],
  });

  const applySession = (s: BrowserSession) => {
    setSession((old) => ({ ...old, ...s }));
    if (s.url) setStartUrl(s.url);
    setImageError(false);
  };
  const [invalidated, setInvalidated] = useState(false);
  const invalidateContract = () => {
    if (wiz.contractId) setInvalidated(true);
    setWiz((w) => ({ ...w, contractId: undefined, contractVersion: undefined }));
  };
  const clearSelection = () => {
    setBbox(null);
    setContainer('');
    setPreview(null);
    setFields([]);
    setDirty(false);
    setCursor(null);
    prev.setError(null);
    save.setError(null);
    invalidateContract();
  };
  const changeSource = (patch: Partial<Pick<WizardState, 'sourceKind' | 'url'>>) => {
    clearSelection();
    setSession(null);
    setRecs([]);
    setNotice(null);
    load.setError(null);
    act.setError(null);
    if (wiz.contractId) setInvalidated(true);
    setWiz((w) => ({ ...w, ...patch, browserSessionId: undefined, contractId: undefined, contractVersion: undefined }));
  };
  const refreshRecommendations = async (id: string) => {
    setRecs([]);
    setStructureOnly(false);
    try {
      const r = await api.recommendations(id);
      setRecs(r.items ?? []);
      setStructureOnly(!!r.structureOnly);
    } catch {
      setNotice('추천 영역을 불러오지 못했어요. 영역 선택 모드에서 직접 선택하거나 화면을 다시 불러와 주세요.');
    }
  };

  const loadScreen = () =>
    load.run(async () => {
      if (busy || (wiz.sourceKind === 'url' && !validUrl)) return;
      setNotice(null);
      clearSelection();
      setSession(null);
      setRecs([]);
      if (wiz.contractId) setInvalidated(true);
      setWiz((w) => ({ ...w, browserSessionId: undefined }));
      await api.guest();
      const s = await api.startBrowser(
        wiz.sourceKind === 'demo' ? { kind: 'demo' } : { kind: 'url', url: wiz.url.trim() },
      );
      applySession(s);
      setStartUrl(s.url ?? wiz.url.trim());
      setWiz((w) => ({ ...w, browserSessionId: s.id }));
      await refreshRecommendations(s.id);
    });

  const runPreview =
    (cont: string, fl: ContractField[], mapping = false) =>
      prev.run(async () => {
        if (mapping && !fl.length) throw new Error('추출할 필드를 하나 이상 선택한 뒤 미리보기를 갱신해 주세요.');
        invalidateContract();
        const item = preview?.container === cont ? preview.item : undefined;
        setPreview(null);
        if (!cont) throw new Error('반복 목록 영역을 먼저 선택해 주세요.');
        const p = await api.previewContract({
          source: buildSource(),
          container: cont,
          ...(item ? { item } : {}),
          ...(mapping || fl.length ? { fields: fl } : {}),
        });
        setPreview(p);
        setFields(p.fields);
        setDirty(false);
      });

  /** 409 page_state_changed: 화면을 새로 받아 오고 선택을 다시 하도록 안내한다. */
  const handleStale = async (e: unknown): Promise<boolean> => {
    if (e instanceof ApiError && e.code === 'page_state_changed' && session) {
      clearSelection();
      setRecs([]);
      try {
        applySession(e.body?.screenshotUrl ? toSession(e.body, session.id) : await api.browserAction(session.id, { type: 'reload' }));
        setNotice('페이지 상태가 바뀌어 새 화면을 불러왔어요. 영역을 다시 선택해 주세요.');
        await refreshRecommendations(session.id);
      } catch (refreshError) {
        setNotice('바뀐 페이지의 화면을 불러오지 못했어요. 화면 불러오기를 눌러 다시 연결해 주세요.');
        throw refreshError;
      }
      return true;
    }
    return false;
  };

  const doAction = (a: BrowserAction) => {
    if (!session || busy) return;
    void act.run(async () => {
      try {
        setNotice(null);
        clearSelection();
        setRecs([]);
        applySession(await api.browserAction(session.id, { ...a, pageStateId: session.pageStateId }));
        await refreshRecommendations(session.id);
      } catch (e) {
        if (!(await handleStale(e))) throw e;
      }
    });
  };

  const onImageClick = (ev: MouseEvent<HTMLImageElement>) => {
    if (!session || busy || imageError || !imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    const x = Math.round(((ev.clientX - r.left) / r.width) * vw);
    const y = Math.round(((ev.clientY - r.top) / r.height) * vh);
    activatePoint(x, y);
  };

  const activatePoint = (x: number, y: number) => {
    if (!session || busy || imageError) return;
    if (mode === 'browse') return doAction({ type: 'click', x, y });
    void act.run(async () => {
      try {
        setNotice(null);
        clearSelection();
        const res = await api.region(session.id, { mode: 'resolve', x, y, pageStateId: session.pageStateId });
        applySession(res.session);
        takeRegion(res.bbox, res.container ?? '', res.canParent, res.canChild);
        await runPreview(res.container ?? '', []);
      } catch (e) {
        if (!(await handleStale(e))) throw e;
      }
    });
  };
  const onImageKeyDown = (ev: KeyboardEvent<HTMLImageElement>) => {
    if (busy || imageError) return;
    const point = cursor ?? { x: Math.floor(vw / 2), y: Math.floor(vh / 2) };
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      activatePoint(point.x, point.y);
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) {
      ev.preventDefault();
      const delta = ev.shiftKey ? 5 : 30;
      setCursor({
        x: Math.max(0, Math.min(vw - 1, point.x + (ev.key === 'ArrowRight' ? delta : ev.key === 'ArrowLeft' ? -delta : 0))),
        y: Math.max(0, Math.min(vh - 1, point.y + (ev.key === 'ArrowDown' ? delta : ev.key === 'ArrowUp' ? -delta : 0))),
      });
    }
  };

  const takeRegion = (b: BBox, cont: string, p?: boolean, c?: boolean) => {
    setBbox(b);
    setContainer(cont);
    setCanParent(p ?? true);
    setCanChild(c ?? true);
  };

  const move = (m: 'parent' | 'child') => {
    if (!session || busy) return;
    void act.run(async () => {
      try {
        setPreview(null);
        invalidateContract();
        const res = await api.region(session.id, { mode: m, pageStateId: session.pageStateId });
        applySession(res.session);
        takeRegion(res.bbox, res.container ?? '', res.canParent, res.canChild);
        await runPreview(res.container ?? '', []);
      } catch (e) {
        if (!(await handleStale(e))) throw e;
      }
    });
  };

  const pickRec = (r: Recommendation) => {
    if (busy) return;
    takeRegion(r.bbox, r.container ?? '', false, false);
    setMode('select');
    setNotice('추천 영역을 선택했어요. 범위를 조정하려면 화면에서 목록 항목을 직접 선택한 뒤 넓히기·좁히기를 사용해 주세요.');
    void runPreview(r.container ?? '', []);
  };

  const setMapping = (key: string, selector: string) => {
    invalidateContract();
    setFields((fl) => {
      const has = fl.some((f) => f.key === key);
      const base = has ? fl : [...fl, { key, selector, value: key === 'detailUrl' ? 'attr:href' : 'text', required: false }];
      return base.map((f) => (f.key === key ? { ...f, selector } : f));
    });
    setDirty(true);
  };

  const saveContract = () =>
    save.run(async () => {
      const mapped = fields.filter((f) => f.selector);
      if (busy || !preview || !preview.itemCount || dirty || !mapped.length) return;
      const c = await api.saveContract({
        source: buildSource(),
        container: preview.container,
        item: preview.item,
        fields: mapped,
        limits: { maxItems: 20, maxDetails: 10, timeoutSeconds: 120 },
      });
      setInvalidated(false);
      setWiz((w) => ({ ...w, contractId: c.contractId, contractVersion: c.version, step: 3 }));
    });

  const allSelectors = Array.from(
    new Set([
      ...fields.map((f) => f.selector),
      ...Object.values(preview?.candidates ?? {}).flat(),
    ]),
  ).filter(Boolean);
  const sortedKeys = [...FIELD_ORDER, ...fields.map((f) => f.key).filter((k) => !FIELD_ORDER.includes(k))];

  return (
    <fieldset className="wizard-panel stack" disabled={busy} aria-busy={busy}>
      <section className="card stack">
        <h2>① 수집처</h2>
        <p className="hint">화면 불러오기 → 목록 영역 선택 → 추출할 필드 확인 순서로 진행해요. 수집처나 영역을 바꾸면 다시 저장해야 해요.</p>
        <fieldset className="radios">
          <legend>수집처 종류</legend>
          <label>
            <input
              type="radio"
              name="src"
              checked={wiz.sourceKind === 'demo'}
              onChange={() => changeSource({ sourceKind: 'demo' })}
            />
            데모용 가상 채용 게시판
          </label>
          <label>
            <input
              type="radio"
              name="src"
              checked={wiz.sourceKind === 'url'}
              onChange={() => changeSource({ sourceKind: 'url' })}
            />
            공개 URL
          </label>
        </fieldset>
        {wiz.sourceKind === 'url' && (
          <>
            <Field label="수집처 URL" error={wiz.url && !validUrl ? 'http:// 또는 https://로 시작하는 공개 주소를 입력해 주세요. 로그인 정보는 포함할 수 없어요.' : undefined}>
              <input
                type="url"
                inputMode="url"
                placeholder="https://example.com/jobs"
                value={wiz.url}
                maxLength={2000}
                aria-invalid={!!wiz.url && !validUrl}
                aria-describedby="source-url-help"
                onChange={(e) => changeSource({ url: e.target.value })}
              />
            </Field>
            <p id="source-url-help" className="hint">로그인 없이 볼 수 있는 http:// 또는 https:// 주소를 입력해 주세요.</p>
            <Notice kind="warn">
              실제 사이트는 best-effort로 지원합니다. 수집 전에 사이트 이용 약관과 robots.txt를 확인해 주세요.
            </Notice>
          </>
        )}
        <div className="row wrap">
          <button
            type="button"
            className={`btn ${session ? '' : 'btn-primary'}`}
            onClick={() => void loadScreen()}
            disabled={busy || (wiz.sourceKind === 'url' && !validUrl)}
          >
            화면 불러오기
          </button>
          {load.busy && <Spinner label="원격 브라우저를 여는 중…" />}
        </div>
        {load.error && <Notice kind="error">{load.error}</Notice>}
      </section>

      {session && imgSrc && (
        <section className="card stack">
          <h2>② 영역 선택{session.provider && <span className="muted"> · {session.provider === 'browserbase' ? 'Browserbase 원격 브라우저' : '로컬 브라우저'}</span>}</h2>
          <div className="row wrap" role="group" aria-label="원격 브라우저 조작">
            <div className="seg" role="group" aria-label="모드">
              <button type="button" className={`btn ${mode === 'browse' ? 'btn-primary' : ''}`} aria-pressed={mode === 'browse'} onClick={() => setMode('browse')}>
                탐색 모드
              </button>
              <button type="button" className={`btn ${mode === 'select' ? 'btn-primary' : ''}`} aria-pressed={mode === 'select'} onClick={() => setMode('select')}>
                영역 선택 모드
              </button>
            </div>
            <button type="button" className="btn" onClick={() => doAction({ type: 'scroll', dy: -600 })} disabled={act.busy}>위로 스크롤</button>
            <button type="button" className="btn" onClick={() => doAction({ type: 'scroll', dy: 600 })} disabled={act.busy}>아래로 스크롤</button>
            <button type="button" className="btn" onClick={() => doAction({ type: 'back' })} disabled={act.busy}>뒤로</button>
            <button type="button" className="btn" onClick={() => doAction({ type: 'reload' })} disabled={act.busy}>새로고침</button>
            <button type="button" className="btn" onClick={() => move('parent')} disabled={act.busy || !bbox || !canParent}>넓히기</button>
            <button type="button" className="btn" onClick={() => move('child')} disabled={act.busy || !bbox || !canChild}>좁히기</button>
            {act.busy && <Spinner label="처리 중…" />}
          </div>
          <p className="hint" id="screen-help">
            {mode === 'browse'
              ? '탐색 모드: 화면을 클릭하면 원격 페이지에 클릭이 전달돼요.'
              : '영역 선택 모드: 목록 항목을 클릭하면 반복 영역이 강조돼요. 넓히기·좁히기로 조정하세요.'}
            {' '}키보드: 화면에 초점을 둔 뒤 방향키로 위치를 옮기고 Enter 또는 Space로 선택하세요. Shift + 방향키로 미세 조정할 수 있어요.
          </p>
          {notice && <Notice kind="warn">{notice}</Notice>}
          {act.error && <Notice kind="error">{act.error}</Notice>}
          {imageError && <Notice kind="error">화면 이미지를 불러오지 못했어요. 새로고침하거나 화면을 다시 불러와 주세요.</Notice>}
          <div className={`shot mode-${mode}`}>
            <img
              ref={imgRef}
              src={imgSrc}
              alt="원격 브라우저 화면. 클릭한 위치가 원격 페이지 좌표로 전달됩니다."
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-disabled={busy || imageError}
              aria-describedby="screen-help"
              aria-label={`${mode === 'browse' ? '원격 화면 탐색' : '목록 영역 선택'}${cursor ? `, 위치 ${cursor.x}, ${cursor.y}` : ''}`}
              onClick={onImageClick}
              onKeyDown={onImageKeyDown}
              onFocus={() => setCursor((p) => p ?? { x: Math.floor(vw / 2), y: Math.floor(vh / 2) })}
              onError={() => setImageError(true)}
              onLoad={() => setImageError(false)}
              draggable={false}
            />
            {cursor && <span className="shot-cursor" aria-hidden="true" style={{ left: `${cursor.x / vw * 100}%`, top: `${cursor.y / vh * 100}%` }} />}
            {bbox && (
              <div
                className="bbox"
                aria-label="선택된 영역"
                style={{
                  left: `${(bbox.x / vw) * 100}%`,
                  top: `${(bbox.y / vh) * 100}%`,
                  width: `${(bbox.width / vw) * 100}%`,
                  height: `${(bbox.height / vh) * 100}%`,
                }}
              />
            )}
          </div>

          <h3>추천 영역 {structureOnly && <span className="badge">구조 기반 추천</span>}</h3>
          {recs.length === 0 ? (
            <p className="hint">추천 영역이 없어요. 영역 선택 모드에서 직접 짚어 주세요.</p>
          ) : (
            <ul className="grid3 plain">
              {recs.slice(0, 3).map((r) => (
                <li key={r.id} className="card">
                  <strong>{r.rank}. {r.name}</strong>
                  <p>{r.reason}</p>
                  {r.itemCount != null && <p className="hint">반복 항목 {r.itemCount}건</p>}
                  <button type="button" className="btn" onClick={() => pickRec(r)} disabled={busy}>
                    이 영역 사용
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(preview || prev.busy || prev.error) && (
        <section className="card stack">
          <h2>③ 필드 확인</h2>
          {prev.busy && <Spinner label="미리보기를 만드는 중…" />}
          {prev.error && <Notice kind="error">{prev.error}</Notice>}
          {prev.error && container && <button type="button" className="btn" onClick={() => void runPreview(container, fields.filter((f) => f.selector), dirty)}>미리보기 다시 시도</button>}
          {preview && (
            <>
              <p>반복 항목 <strong>{preview.itemCount}</strong>건</p>
              {preview.itemCount === 0 && <Notice kind="warn">빈 목록이에요. 다른 영역을 선택해 보세요.</Notice>}
              {preview.warnings?.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
              <div className="mapping">
                {sortedKeys.map((key) => {
                  const f = fields.find((x) => x.key === key);
                  return (
                    <Field key={key} label={FIELD_LABELS[key] ?? key}>
                      <select value={f?.selector ?? NONE} onChange={(e) => setMapping(key, e.target.value)}>
                        <option value={NONE}>(사용 안 함)</option>
                        {Array.from(new Set([...(preview.candidates?.[key] ?? []), ...allSelectors])).map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </Field>
                  );
                })}
              </div>
              <div className="row wrap">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runPreview(preview.container, fields.filter((f) => f.selector), true)}
                  disabled={busy || !fields.some((f) => f.selector)}
                >
                  미리보기 갱신{dirty ? ' *' : ''}
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <caption>추출 미리보기 · 최대 10건{dirty ? ' · 변경 전 결과' : ''}</caption>
                  <thead>
                    <tr>{sortedKeys.filter((k) => fields.some((f) => f.key === k)).map((k) => <th key={k} scope="col">{FIELD_LABELS[k] ?? k}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 10).map((row, i) => (
                      <tr key={i}>
                        {sortedKeys.filter((k) => fields.some((f) => f.key === k)).map((k) => (
                          <td key={k}>{row[k] ?? <span className="hint">없음</span>}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row wrap">
                <button
                  type="button"
                  className={`btn ${wiz.contractId ? '' : 'btn-primary'}`}
                  onClick={() => void saveContract()}
                  disabled={busy || preview.itemCount === 0 || dirty || !fields.some((f) => f.selector)}
                >
                  저장하고 다음
                </button>
                {dirty && <span className="hint">매핑을 바꿨어요. 미리보기를 갱신한 뒤 저장하세요.</span>}
                {!fields.some((f) => f.selector) && <span className="hint">추출할 필드를 하나 이상 선택해 주세요.</span>}
                {save.busy && <Spinner label="계약 저장 중…" />}
              </div>
              {save.error && <Notice kind="error">{save.error}</Notice>}
            </>
          )}
        </section>
      )}
      {!wiz.contractId && invalidated && (
        <Notice kind="warn">이전에 저장한 수집 계약이 무효가 되었어요. 수집처·화면·영역·필드를 바꿨다면 다시 저장해야 다음 단계로 갈 수 있어요.</Notice>
      )}
      {wiz.contractId && (
        <Notice kind="ok">저장된 수집 계약: {wiz.contractId} (v{wiz.contractVersion}). 다음 단계로 넘어갈 수 있어요.</Notice>
      )}
    </fieldset>
  );
}
