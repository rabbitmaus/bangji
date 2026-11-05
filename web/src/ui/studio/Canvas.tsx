import { useEffect, useMemo } from 'react';
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, useNodesState,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeCatalogEntry, WorkflowDefinition } from './workflowTypes';
import { portsCompatible, topoOrder, uniqueId, type NodeRunState } from './workflowApi';

type FlowData = { label: string; kind: string; cat?: NodeCatalogEntry; run?: NodeRunState; selected: boolean };
type FlowNode = Node<FlowData, 'wf'>;

export const KIND_COLORS: Record<string, string> = {
  collect: '#2563eb', mergeDedupe: '#0891b2', normalizeFields: '#0d9488', ruleFilter: '#7c3aed', evidenceEvaluate: '#c026d3',
  branch: '#d97706', humanReview: '#dc2626', tailor: '#16a34a', exportMarkdown: '#475569', exportList: '#475569',
};
export const RUN_STATUS_TEXT: Record<string, string> = {
  pending: '대기', queued: '대기', running: '실행 중', completed: '완료', failed: '실패', waiting: '검토 대기', skipped: '건너뜀', cancelled: '취소됨',
};

function WfNode({ data }: NodeProps<FlowNode>) {
  const color = KIND_COLORS[data.kind] ?? '#64748b';
  const ins = data.cat?.inputs ?? [];
  const outs = data.cat?.outputs ?? [];
  return (
    <div className={`wf-node${data.selected ? ' is-selected' : ''}`} style={{ borderColor: color }}>
      {ins.map((p, i) => (
        <Handle key={p.name} id={p.name} type="target" position={Position.Left} title={`${p.label} (${p.type})`}
          style={{ top: 28 + i * 18, background: color }} />
      ))}
      <div className="wf-node-head" style={{ background: color }}>{data.cat?.label ?? data.kind}</div>
      <div className="wf-node-body">
        <div>{data.label}</div>
        {data.run && (
          <div className={`wf-node-status s-${data.run.status}`}>
            {RUN_STATUS_TEXT[data.run.status] ?? data.run.status} · {data.run.inputCount}→{data.run.outputCount}
          </div>
        )}
      </div>
      {outs.map((p, i) => (
        <Handle key={p.name} id={p.name} type="source" position={Position.Right} title={`${p.label} (${p.type})`}
          style={{ top: 28 + i * 18, background: color }} />
      ))}
    </div>
  );
}

const nodeTypes = { wf: WfNode };

export interface CanvasProps {
  def: WorkflowDefinition;
  catalog: Map<string, NodeCatalogEntry>;
  selectedId: string | null;
  runNodes?: Record<string, NodeRunState>;
  onSelect: (id: string | null) => void;
  update: (fn: (d: WorkflowDefinition) => WorkflowDefinition) => void;
}

export function Canvas({ def, catalog, selectedId, runNodes, onSelect, update }: CanvasProps) {
  const computed = useMemo<FlowNode[]>(() => {
    const order = topoOrder(def);
    return def.nodes.map((n) => {
      const idx = order.indexOf(n.id);
      return {
        id: n.id,
        type: 'wf' as const,
        position: def.layout?.[n.id] ?? { x: 40 + idx * 260, y: 40 + (idx % 2) * 60 },
        data: { label: n.label || n.id, kind: n.kind, cat: catalog.get(n.kind), run: runNodes?.[n.id], selected: n.id === selectedId },
      };
    });
  }, [def, catalog, runNodes, selectedId]);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(computed);
  useEffect(() => { setNodes(computed); }, [computed, setNodes]);

  const edges = useMemo<Edge[]>(() => def.edges.map((e) => ({
    id: e.id, source: e.from.node, sourceHandle: e.from.port, target: e.to.node, targetHandle: e.to.port, label: e.when,
  })), [def.edges]);

  const portType = (nodeId: string | null | undefined, port: string | null | undefined, dir: 'inputs' | 'outputs') => {
    const n = def.nodes.find((x) => x.id === nodeId);
    return catalog.get(n?.kind ?? '')?.[dir].find((p) => p.name === port)?.type;
  };

  const isValid = (c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const a = portType(c.source, c.sourceHandle, 'outputs');
    const b = portType(c.target, c.targetHandle, 'inputs');
    return !!a && !!b && portsCompatible(a, b);
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const from = { node: c.source, port: c.sourceHandle };
    const to = { node: c.target, port: c.targetHandle };
    update((d) => ({ ...d, edges: [...d.edges, { id: uniqueId('edge', d.edges.map((x) => x.id)), from, to }] }));
  };

  return (
    <section className="wf-panel wf-canvas" aria-label="캔버스 (마우스용 보기, 키보드는 단계 목록 사용)">
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={isValid}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_, n) => update((d) => ({ ...d, layout: { ...(d.layout ?? {}), [n.id]: { x: n.position.x, y: n.position.y } } }))}
        onNodesDelete={(del) => {
          const ids = new Set(del.map((n) => n.id));
          update((d) => ({ ...d, nodes: d.nodes.filter((n) => !ids.has(n.id)), edges: d.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node)) }));
        }}
        onEdgesDelete={(del) => {
          const ids = new Set(del.map((e) => e.id));
          update((d) => (d.edges.some((e) => ids.has(e.id)) ? { ...d, edges: d.edges.filter((e) => !ids.has(e.id)) } : d));
        }}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(n) => KIND_COLORS[(n.data as FlowData).kind] ?? '#64748b'} />
      </ReactFlow>
    </section>
  );
}
