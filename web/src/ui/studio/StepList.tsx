import { useMemo, useState } from 'react';
import type { EdgeCondition, EdgeDef, NodeCatalogEntry, NodeDef, ValidationIssue, WorkflowDefinition } from './workflowTypes';
import { topoOrder, uniqueId } from './workflowApi';

const CONDITIONS: EdgeCondition[] = ['pass', 'reject', 'hold', 'else', 'true', 'false'];

export interface StepListProps {
  def: WorkflowDefinition;
  catalog: Map<string, NodeCatalogEntry>;
  selectedId: string | null;
  issues: ValidationIssue[];
  onSelect: (id: string) => void;
  onAddNode: () => void;
  update: (fn: (d: WorkflowDefinition) => WorkflowDefinition) => void;
}

function summarize(n: NodeDef): string {
  const parts = Object.entries(n.config ?? {}).slice(0, 3).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${(s ?? '').length > 24 ? `${(s ?? '').slice(0, 24)}…` : s}`;
  });
  return parts.length ? parts.join(' · ') : '설정 없음';
}

function portNames(cat: NodeCatalogEntry | undefined, dir: 'inputs' | 'outputs', current: string): string[] {
  const names = (cat?.[dir] ?? []).map((p) => p.name);
  return names.includes(current) || !current ? names : [...names, current];
}

function EdgeRow({ e, props }: { e: EdgeDef; props: StepListProps }) {
  const { def, catalog, update } = props;
  const nodeOf = (id: string) => def.nodes.find((n) => n.id === id);
  const set = (patch: Partial<EdgeDef>) => update((d) => ({ ...d, edges: d.edges.map((x) => (x.id === e.id ? { ...x, ...patch } : x)) }));
  const fromCat = catalog.get(nodeOf(e.from.node)?.kind ?? '');
  const toCat = catalog.get(nodeOf(e.to.node)?.kind ?? '');
  return (
    <li className="wf-edge-row">
      <span>{nodeOf(e.from.node)?.label || e.from.node}</span>
      <label>
        <span className="wf-sr">출력 포트</span>
        <select aria-label="출력 포트" value={e.from.port} onChange={(ev) => set({ from: { ...e.from, port: ev.target.value } })}>
          {portNames(fromCat, 'outputs', e.from.port).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <span aria-hidden="true">→</span>
      <span>{nodeOf(e.to.node)?.label || e.to.node}</span>
      <label>
        <span className="wf-sr">입력 포트</span>
        <select aria-label="입력 포트" value={e.to.port} onChange={(ev) => set({ to: { ...e.to, port: ev.target.value } })}>
          {portNames(toCat, 'inputs', e.to.port).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label>
        <span className="wf-sr">조건</span>
        <select aria-label="연결 조건" value={e.when ?? ''} onChange={(ev) => set({ when: (ev.target.value || undefined) as EdgeCondition | undefined })}>
          <option value="">조건 없음</option>
          {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => update((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== e.id) }))}>연결 삭제</button>
    </li>
  );
}

function AddEdgeForm({ props }: { props: StepListProps }) {
  const { def, catalog, update } = props;
  const allPorts = useMemo(() => {
    const s = new Set<string>();
    catalog.forEach((c) => [...c.inputs, ...c.outputs].forEach((p) => s.add(p.name)));
    return [...s];
  }, [catalog]);
  const first = def.nodes[0]?.id ?? '';
  const [fromNode, setFromNode] = useState('');
  const [fromPort, setFromPort] = useState('');
  const [toNode, setToNode] = useState('');
  const [toPort, setToPort] = useState('');
  const [when, setWhen] = useState('');
  const fn = fromNode || first;
  const tn = toNode || first;
  const fp = fromPort || allPorts[0] || '';
  const tp = toPort || allPorts[0] || '';

  const add = () => {
    update((d) => ({
      ...d,
      edges: [...d.edges, {
        id: uniqueId('edge', d.edges.map((x) => x.id)),
        from: { node: fn, port: fp }, to: { node: tn, port: tp },
        ...(when ? { when: when as EdgeCondition } : {}),
      }],
    }));
  };

  return (
    <form className="wf-edge-form" onSubmit={(ev) => { ev.preventDefault(); add(); }} aria-label="연결 추가">
      <h3>연결 추가</h3>
      <p className="wf-muted">모든 노드와 포트를 자유롭게 고를 수 있어요. 맞지 않는 연결은 검증에서 오류로 표시돼요.</p>
      <div className="wf-row">
        <label>시작 노드
          <select value={fn} onChange={(e) => setFromNode(e.target.value)}>
            {def.nodes.map((n) => <option key={n.id} value={n.id}>{n.label || n.id}</option>)}
          </select>
        </label>
        <label>출력 포트
          <select value={fp} onChange={(e) => setFromPort(e.target.value)}>
            {allPorts.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>도착 노드
          <select value={tn} onChange={(e) => setToNode(e.target.value)}>
            {def.nodes.map((n) => <option key={n.id} value={n.id}>{n.label || n.id}</option>)}
          </select>
        </label>
        <label>입력 포트
          <select value={tp} onChange={(e) => setToPort(e.target.value)}>
            {allPorts.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>조건
          <select value={when} onChange={(e) => setWhen(e.target.value)}>
            <option value="">조건 없음</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button type="submit" disabled={def.nodes.length === 0}>연결 추가</button>
      </div>
    </form>
  );
}

export function StepList(props: StepListProps) {
  const { def, catalog, selectedId, issues, onSelect, onAddNode, update } = props;
  const order = useMemo(() => topoOrder(def), [def]);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));

  const setNode = (id: string, patch: Partial<NodeDef>) =>
    update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));

  const move = (id: string, dir: -1 | 1) =>
    update((d) => {
      const i = d.nodes.findIndex((n) => n.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.nodes.length) return d;
      const nodes = d.nodes.slice();
      [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      return { ...d, nodes };
    });

  const remove = (id: string) =>
    update((d) => {
      const layout = d.layout ? { ...d.layout } : undefined;
      if (layout) delete layout[id];
      return { ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.from.node !== id && e.to.node !== id), layout };
    });

  return (
    <section className="wf-panel wf-steps" aria-label="단계 목록">
      <div className="wf-row wf-between">
        <h2>단계 목록</h2>
        <button type="button" onClick={onAddNode}>노드 추가</button>
      </div>
      {def.nodes.length === 0 && <p className="wf-muted">아직 단계가 없어요. ‘노드 추가’로 시작해 보세요.</p>}
      <ol className="wf-step-list">
        {order.map((id, idx) => {
          const n = byId.get(id);
          if (!n) return null;
          const cat = catalog.get(n.kind);
          const nodeIssues = issues.filter((i) => i.nodeId === n.id);
          const edges = def.edges.filter((e) => e.from.node === n.id || e.to.node === n.id);
          return (
            <li key={n.id} className={`wf-step${selectedId === n.id ? ' is-selected' : ''}${nodeIssues.length ? ' has-issue' : ''}`} data-kind={n.kind}>
              <div className="wf-row">
                <span className="wf-step-no">{idx + 1}</span>
                <input aria-label="단계 이름" value={n.label ?? ''} placeholder={cat?.label ?? n.kind} onChange={(e) => setNode(n.id, { label: e.target.value })} onFocus={() => onSelect(n.id)} />
                <span className="wf-kind" data-kind={n.kind}>{cat?.label ?? n.kind}</span>
                <button type="button" aria-pressed={selectedId === n.id} onClick={() => onSelect(n.id)}>선택</button>
                <button type="button" aria-label={`${n.label || n.id} 위로 이동`} onClick={() => move(n.id, -1)}>↑</button>
                <button type="button" aria-label={`${n.label || n.id} 아래로 이동`} onClick={() => move(n.id, 1)}>↓</button>
                <button type="button" aria-label={`${n.label || n.id} 삭제`} onClick={() => remove(n.id)}>삭제</button>
              </div>
              <div className="wf-muted wf-summary">{summarize(n)}</div>
              {nodeIssues.map((i, k) => <div key={k} className="wf-issue-inline">⚠ {i.message}</div>)}
              <details className="wf-conn">
                <summary>연결 편집 ({edges.length})</summary>
                {edges.length === 0 ? <p className="wf-muted">연결이 없어요.</p> : (
                  <ul className="wf-edge-list">{edges.map((e) => <EdgeRow key={e.id} e={e} props={props} />)}</ul>
                )}
              </details>
            </li>
          );
        })}
      </ol>
      <AddEdgeForm props={props} />
    </section>
  );
}
