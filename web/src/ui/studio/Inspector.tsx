import { useEffect, useState } from 'react';
import { WORKFLOW_LIMIT_MAX, type NodeCatalogEntry, type NodeDef, type WorkflowDefinition, type WorkflowLimits } from './workflowTypes';

const LIMIT_LABEL: Record<keyof WorkflowLimits, string> = {
  maxItems: '최대 항목 수', maxDetails: '최대 상세 조회 수', maxModelCalls: '최대 모델 호출 수', runSeconds: '실행 제한(초)', maxFanout: '최대 분기 수',
};

const clamp = (v: number, max: number) => Math.min(max, Math.max(1, Math.floor(Number.isFinite(v) ? v : 1)));

function JsonConfig({ nodeId, value, onChange }: { nodeId: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError(null); }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="wf-field">
      <label htmlFor="wf-json">설정 JSON (고급)</label>
      <textarea id="wf-json" rows={6} value={text} aria-invalid={!!error} aria-describedby={error ? 'wf-json-err' : undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('객체(JSON)여야 해요');
            setError(null);
            onChange(v as Record<string, unknown>);
          } catch (err) {
            setError(`JSON 오류: ${err instanceof Error ? err.message : '해석할 수 없어요'}`);
          }
        }} />
      {error && <div id="wf-json-err" role="alert" className="wf-issue-inline">{error}</div>}
    </div>
  );
}

function ConfigForm({ node, cat, setConfig }: { node: NodeDef; cat?: NodeCatalogEntry; setConfig: (c: Record<string, unknown>) => void }) {
  const keys = Array.from(new Set([...Object.keys(cat?.defaultConfig ?? {}), ...Object.keys(node.config ?? {})]));
  const prim = keys.filter((k) => {
    const v = node.config?.[k] ?? cat?.defaultConfig?.[k];
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  });
  const set = (k: string, v: unknown) => setConfig({ ...node.config, [k]: v });
  return (
    <>
      {prim.map((k) => {
        const v = node.config?.[k] ?? cat?.defaultConfig?.[k];
        const id = `wf-cfg-${k}`;
        if (typeof v === 'boolean') {
          return <label key={k} className="wf-check"><input type="checkbox" checked={v} onChange={(e) => set(k, e.target.checked)} /> {k}</label>;
        }
        return (
          <div key={k} className="wf-field">
            <label htmlFor={id}>{k}</label>
            <input id={id} type={typeof v === 'number' ? 'number' : 'text'} value={String(v)}
              onChange={(e) => set(k, typeof v === 'number' ? Number(e.target.value) : e.target.value)} />
          </div>
        );
      })}
      <JsonConfig nodeId={node.id} value={node.config ?? {}} onChange={setConfig} />
    </>
  );
}

export interface InspectorProps {
  def: WorkflowDefinition;
  node: NodeDef | null;
  cat?: NodeCatalogEntry;
  update: (fn: (d: WorkflowDefinition) => WorkflowDefinition) => void;
}

export function Inspector({ def, node, cat, update }: InspectorProps) {
  const setNode = (patch: Partial<NodeDef>) => {
    if (!node) return;
    update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) }));
  };
  const setLimit = (k: keyof WorkflowLimits, v: number) =>
    update((d) => ({ ...d, limits: { ...d.limits, [k]: clamp(v, WORKFLOW_LIMIT_MAX[k]) } }));

  return (
    <section className="wf-panel" aria-label="인스펙터">
      <h2>인스펙터</h2>
      {node ? (
        <div className="wf-stack">
          <p className="wf-muted">{cat?.label ?? node.kind} <code>{node.id}</code>{cat ? ` — ${cat.description}` : ''}</p>
          <div className="wf-field">
            <label htmlFor="wf-label">라벨</label>
            <input id="wf-label" value={node.label ?? ''} onChange={(e) => setNode({ label: e.target.value })} />
          </div>
          <div className="wf-field">
            <label htmlFor="wf-timeout">제한 시간(초)</label>
            <input id="wf-timeout" type="number" min={1} value={node.timeoutSeconds ?? ''}
              onChange={(e) => setNode({ timeoutSeconds: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })} />
          </div>
          <div className="wf-field">
            <label htmlFor="wf-retry">재시도 횟수 (최대 2)</label>
            <input id="wf-retry" type="number" min={0} max={2} value={node.retry?.max ?? 0}
              onChange={(e) => setNode({ retry: { max: Math.min(2, Math.max(0, Math.floor(Number(e.target.value) || 0))) } })} />
          </div>
          <ConfigForm node={node} cat={cat} setConfig={(config) => setNode({ config })} />
        </div>
      ) : <p className="wf-muted">노드를 선택하면 설정을 편집할 수 있어요.</p>}

      <h3>워크플로 한도</h3>
      <div className="wf-limits">
        {(Object.keys(LIMIT_LABEL) as (keyof WorkflowLimits)[]).map((k) => (
          <div key={k} className="wf-field">
            <label htmlFor={`wf-lim-${k}`}>{LIMIT_LABEL[k]} (최대 {WORKFLOW_LIMIT_MAX[k]})</label>
            <input id={`wf-lim-${k}`} type="number" min={1} max={WORKFLOW_LIMIT_MAX[k]} value={def.limits[k]}
              onChange={(e) => setLimit(k, Number(e.target.value))} />
          </div>
        ))}
      </div>
    </section>
  );
}
