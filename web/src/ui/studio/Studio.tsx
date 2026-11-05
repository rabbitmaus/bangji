import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './studio.css';
import type { NodeCatalogEntry, NodeKind, ValidationResult, WorkflowDefinition, WorkflowSummary, WorkflowView, DefinitionChange } from './workflowTypes';
import { wf, WfError, wfErrorMessage, uniqueId, type RunDoc, type TemplateName } from './workflowApi';
import { StepList } from './StepList';
import { Canvas } from './Canvas';
import { Inspector } from './Inspector';
import { Palette } from './Palette';
import { AssistPanel, DiffList } from './AssistPanel';
import { RunPanel, type RunTrigger } from './RunPanel';

const TEMPLATES: { id: TemplateName; label: string }[] = [
  { id: 'jobsToResume', label: '채용 공고 → 이력서 맞춤' },
  { id: 'jobsListOnly', label: '채용 공고 목록만' },
  { id: 'twoSourceMerge', label: '두 출처 병합' },
  { id: 'empty', label: '빈 워크플로' },
];
const STATUS_TEXT = { draft: '초안', validated: '검증됨', approved: '승인됨' } as const;
const HISTORY_MAX = 50;

export default function Studio() {
  const [catalogList, setCatalogList] = useState<NodeCatalogEntry[]>([]);
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [view, setView] = useState<WorkflowView | null>(null);
  const [def, setDefState] = useState<WorkflowDefinition | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [template, setTemplate] = useState<TemplateName>('jobsToResume');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [versions, setVersions] = useState<WorkflowSummary[]>([]);
  const [diffRev, setDiffRev] = useState('');
  const [diff, setDiff] = useState<DefinitionChange[] | null>(null);
  const [runDoc, setRunDoc] = useState<RunDoc | null>(null);
  const [trigger, setTrigger] = useState<RunTrigger | null>(null);
  const [, setTick] = useState(0);

  const defRef = useRef<WorkflowDefinition | null>(null);
  const past = useRef<WorkflowDefinition[]>([]);
  const future = useRef<WorkflowDefinition[]>([]);

  const catalog = useMemo(() => new Map(catalogList.map((c) => [c.kind, c])), [catalogList]);

  const setDef = (d: WorkflowDefinition | null) => { defRef.current = d; setDefState(d); };

  const update = useCallback((fn: (d: WorkflowDefinition) => WorkflowDefinition) => {
    const cur = defRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    past.current = [...past.current, cur].slice(-HISTORY_MAX);
    future.current = [];
    defRef.current = next;
    setDefState(next);
    setTick((t) => t + 1);
  }, []);

  const undo = () => {
    const prev = past.current.pop();
    if (!prev || !defRef.current) return;
    future.current.push(defRef.current);
    setDef(prev); setTick((t) => t + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !defRef.current) return;
    past.current.push(defRef.current);
    setDef(next); setTick((t) => t + 1);
  };

  const refreshList = useCallback(async () => {
    try { setList(await wf.list()); } catch (e) { setMessage(wfErrorMessage(e)); }
  }, []);

  const adopt = useCallback((v: WorkflowView) => {
    setView(v);
    setDef(v.definition);
    setValidation(v.validation);
    past.current = []; future.current = [];
    setConflict(false); setDiff(null); setDiffRev('');
    setSelectedId((s) => (s && v.definition.nodes.some((n) => n.id === s) ? s : null));
    wf.versions(v.workflowId).then(setVersions).catch(() => setVersions([]));
    setTick((t) => t + 1);
  }, []);

  const open = useCallback(async (id: string) => {
    setBusy(true); setMessage(null); setRunDoc(null);
    try { adopt(await wf.get(id)); } catch (e) { setMessage(wfErrorMessage(e)); } finally { setBusy(false); }
  }, [adopt]);

  useEffect(() => {
    wf.catalog().then(setCatalogList).catch((e) => setMessage(wfErrorMessage(e)));
    wf.list().then((l) => { setList(l); if (l[0]) void open(l[0].workflowId); }).catch((e) => setMessage(wfErrorMessage(e)));
  }, [open]);

  const dirty = !!view && !!def && JSON.stringify(def) !== JSON.stringify(view.definition);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (e) {
      if (e instanceof WfError && e.status === 409) setConflict(true);
      setMessage(wfErrorMessage(e));
    } finally { setBusy(false); }
  };

  const create = () => run(async () => {
    const v = await wf.create(template, newName.trim() || '새 워크플로');
    setRunDoc(null); adopt(v); await refreshList();
  });

  const save = () => run(async () => {
    if (!view || !def) return;
    adopt(await wf.save(view.workflowId, view.revision, def));
    await refreshList();
    setMessage('저장했어요.');
  });

  const validate = () => run(async () => {
    if (!view || !def) return;
    if (dirty) adopt(await wf.save(view.workflowId, view.revision, def));
    adopt(await wf.validate(view.workflowId));
    await refreshList();
  });

  const approve = () => run(async () => {
    if (!view) return;
    adopt(await wf.approve(view.workflowId, view.revision));
    await refreshList();
    setMessage('승인했어요.');
  });

  const compare = (rev: string) => {
    setDiffRev(rev);
    setDiff(null);
    if (!rev || !view) return;
    wf.diff(view.workflowId, Number(rev), view.revision).then((r) => setDiff(r.changes)).catch((e) => setMessage(wfErrorMessage(e)));
  };

  const addNode = (c: NodeCatalogEntry) => {
    if (!def) return;
    const id = uniqueId(c.kind, def.nodes.map((n) => n.id));
    update((d) => ({ ...d, nodes: [...d.nodes, { id, kind: c.kind, label: c.label, config: JSON.parse(JSON.stringify(c.defaultConfig ?? {})) }] }));
    setSelectedId(id);
    setPaletteOpen(false);
  };

  const trig = (mode: 'sample' | 'full') => setTrigger((t) => ({ mode, n: (t?.n ?? 0) + 1 }));

  const status = view?.status ?? 'draft';
  const canRunFull = !!view && view.status === 'approved' && !dirty;
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  const selectedNode = def?.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="wf-studio">
      <h1>Workflow 스튜디오</h1>

      <div className="wf-toolbar" role="toolbar" aria-label="워크플로 도구">
        <label>템플릿
          <select value={template} onChange={(e) => setTemplate(e.target.value as TemplateName)}>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label>이름
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 워크플로" />
        </label>
        <button type="button" onClick={create} disabled={busy}>새로 만들기</button>
        <label>워크플로 열기
          <select value={view?.workflowId ?? ''} onChange={(e) => e.target.value && void open(e.target.value)} disabled={busy}>
            <option value="">선택…</option>
            {list.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name} (r{w.revision})</option>)}
          </select>
        </label>
        <span className="wf-sep" aria-hidden="true" />
        <button type="button" onClick={undo} disabled={past.current.length === 0}>되돌리기</button>
        <button type="button" onClick={redo} disabled={future.current.length === 0}>다시하기</button>
        <button type="button" onClick={save} disabled={!view || !dirty || busy}>저장</button>
        <button type="button" onClick={validate} disabled={!view || busy}>검증</button>
        <button type="button" onClick={approve} disabled={!view || dirty || busy || errors.length > 0 || status === 'approved'}>승인</button>
        <button type="button" onClick={() => trig('sample')} disabled={!view || dirty || busy}>샘플 실행</button>
        <button type="button" onClick={() => trig('full')} disabled={!canRunFull || busy}>실행</button>
        {view && (
          <span className="wf-badges">
            <span className={`wf-badge st-${status}`}>{STATUS_TEXT[status]}</span>
            {dirty && <span className="wf-badge st-dirty">변경됨</span>}
          </span>
        )}
      </div>

      <div aria-live="polite" className="wf-message">
        {message}
        {conflict && view && <> <button type="button" onClick={() => void open(view.workflowId)}>최신 버전 다시 불러오기</button></>}
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <div role="alert" className="wf-banner">
          <strong>검증 결과: 오류 {errors.length}건, 경고 {warnings.length}건</strong>
          <ul>
            {[...errors.map((i) => ({ i, err: true })), ...warnings.map((i) => ({ i, err: false }))].map(({ i, err }, k) => (
              <li key={k} className={err ? 'is-error' : 'is-warn'}>
                {i.nodeId ? (
                  <button type="button" className="wf-linklike" onClick={() => setSelectedId(i.nodeId ?? null)}>{err ? '오류' : '경고'}: {i.message}</button>
                ) : <span>{err ? '오류' : '경고'}: {i.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!def || !view ? (
        <p className="wf-muted">워크플로를 만들거나 열어 주세요.</p>
      ) : (
        <>
          <div className="wf-meta wf-row">
            <label>워크플로 이름
              <input value={def.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} />
            </label>
            <label>비교할 버전
              <select value={diffRev} onChange={(e) => compare(e.target.value)}>
                <option value="">선택…</option>
                {versions.filter((v) => v.revision !== view.revision).map((v) => <option key={v.revision} value={v.revision}>r{v.revision} ({STATUS_TEXT[v.status]})</option>)}
              </select>
            </label>
          </div>
          {diffRev && (
            <section className="wf-panel" aria-label="버전 비교">
              <h3>r{diffRev} → r{view.revision} 변경점</h3>
              {diff ? <DiffList changes={diff} /> : <p className="wf-muted">불러오는 중…</p>}
            </section>
          )}
          <div className="wf-grid">
            <div className="wf-col">
              <StepList def={def} catalog={catalog} selectedId={selectedId} issues={errors.concat(warnings)}
                onSelect={setSelectedId} onAddNode={() => setPaletteOpen(true)} update={update} />
            </div>
            <div className="wf-col wf-col-canvas">
              <Canvas def={def} catalog={catalog} selectedId={selectedId} runNodes={runDoc?.nodes} onSelect={setSelectedId} update={update} />
            </div>
            <div className="wf-col">
              <Inspector def={def} node={selectedNode} cat={selectedNode ? catalog.get(selectedNode.kind as NodeKind) : undefined} update={update} />
              <AssistPanel workflowId={view.workflowId} baseRevision={view.revision} dirty={dirty} onApplied={() => open(view.workflowId)} />
              <RunPanel key={view.workflowId} workflowId={view.workflowId} revision={view.revision} def={def}
                trigger={trigger} onRunDoc={setRunDoc} onSelect={setSelectedId} />
            </div>
          </div>
        </>
      )}

      {paletteOpen && <Palette catalog={catalogList} onPick={addNode} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
