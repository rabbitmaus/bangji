import { createHash } from 'node:crypto';
import { NODE_CATALOG, isKnownKind, portsCompatible } from './catalog.js';
import {
  FORBIDDEN_KINDS, WORKFLOW_LIMIT_MAX,
  type DefinitionChange, type EdgeDef, type NodeDef, type ValidationIssue, type ValidationResult, type WorkflowDefinition,
} from './schema.js';

export interface ValidateContext { hasResumeFacts?: boolean }

export function validateDefinition(def: WorkflowDefinition, ctx: ValidateContext = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, extra: { nodeId?: string; edgeId?: string } = {}) => errors.push({ code, message, ...extra });
  const warn = (code: string, message: string, extra: { nodeId?: string; edgeId?: string } = {}) => warnings.push({ code, message, ...extra });

  if (def.approvalPolicy.requireApprovalBeforeRun !== true) err('policy_violation', '실행 전 승인은 끌 수 없어요');
  if (def.approvalPolicy.forbidExternalSubmit !== true) err('policy_violation', '외부 사이트 제출 금지는 끌 수 없어요');
  if (def.approvalPolicy.requireHumanReviewForArtifacts !== true) err('policy_violation', '결과물에 대한 사람 검토는 끌 수 없어요');

  for (const [key, max] of Object.entries(WORKFLOW_LIMIT_MAX)) {
    const v = def.limits[key as keyof typeof WORKFLOW_LIMIT_MAX];
    if (v > max) err('limit_exceeded', `${key} 한도는 ${max}을(를) 넘을 수 없어요 (현재 ${v})`);
  }

  const nodes = new Map<string, NodeDef>();
  for (const n of def.nodes) {
    if (nodes.has(n.id)) { err('duplicate_node_id', `노드 ID "${n.id}"가 중복돼요`, { nodeId: n.id }); continue; }
    nodes.set(n.id, n);
    if (FORBIDDEN_KINDS[n.kind]) { err('forbidden_kind', FORBIDDEN_KINDS[n.kind], { nodeId: n.id }); continue; }
    if (!isKnownKind(n.kind)) { err('unknown_kind', `알 수 없는 노드 종류예요: ${n.kind}`, { nodeId: n.id }); continue; }
    const spec = NODE_CATALOG[n.kind];
    if (!spec.supported) { err('unsupported_kind', `아직 지원하지 않는 노드예요: ${spec.label}`, { nodeId: n.id }); continue; }
    const parsed = spec.config.safeParse(n.config);
    if (!parsed.success) err('invalid_config', `${spec.label} 설정이 올바르지 않아요: ${parsed.error.issues[0]?.message ?? ''}`.trim(), { nodeId: n.id });
    if (spec.needsResumeFacts && ctx.hasResumeFacts === false) err('resume_facts_required', '이력서 맞춤 단계에는 이력서 사실 정보가 필요해요. 이력서를 먼저 등록해 주세요', { nodeId: n.id });
  }

  const edgeIds = new Set<string>();
  const validEdges: EdgeDef[] = [];
  for (const e of def.edges) {
    if (edgeIds.has(e.id)) { err('duplicate_edge_id', `연결 ID "${e.id}"가 중복돼요`, { edgeId: e.id }); continue; }
    edgeIds.add(e.id);
    const from = nodes.get(e.from.node);
    const to = nodes.get(e.to.node);
    if (!from || !to) { err('dangling_edge', `연결 "${e.id}"이(가) 없는 노드를 가리켜요`, { edgeId: e.id }); continue; }
    if (!isKnownKind(from.kind) || !isKnownKind(to.kind)) continue;
    const outPort = NODE_CATALOG[from.kind].outputs.find((p) => p.name === e.from.port);
    const inPort = NODE_CATALOG[to.kind].inputs.find((p) => p.name === e.to.port);
    if (!outPort) { err('unknown_port', `"${from.label ?? from.id}"에는 "${e.from.port}" 출력이 없어요`, { edgeId: e.id, nodeId: from.id }); continue; }
    if (!inPort) { err('unknown_port', `"${to.label ?? to.id}"에는 "${e.to.port}" 입력이 없어요`, { edgeId: e.id, nodeId: to.id }); continue; }
    if (!portsCompatible(outPort.type, inPort.type)) {
      err('port_type_mismatch', `${outPort.type} 출력은 ${inPort.type} 입력에 연결할 수 없어요`, { edgeId: e.id });
      continue;
    }
    validEdges.push(e);
  }

  const incoming = new Map<string, EdgeDef[]>();
  const outgoing = new Map<string, EdgeDef[]>();
  for (const e of validEdges) {
    (incoming.get(e.to.node) ?? incoming.set(e.to.node, []).get(e.to.node)!).push(e);
    (outgoing.get(e.from.node) ?? outgoing.set(e.from.node, []).get(e.from.node)!).push(e);
  }

  for (const n of nodes.values()) {
    if (!isKnownKind(n.kind)) continue;
    const spec = NODE_CATALOG[n.kind];
    const ins = incoming.get(n.id) ?? [];
    for (const p of spec.inputs) {
      const count = ins.filter((e) => e.to.port === p.name).length;
      if (p.required && count === 0) err('missing_input', `"${n.label ?? spec.label}"의 "${p.label}" 입력이 연결되지 않았어요`, { nodeId: n.id });
      if (!p.multi && count > 1) err('multiple_inputs', `"${n.label ?? spec.label}"의 "${p.label}" 입력에는 하나만 연결할 수 있어요`, { nodeId: n.id });
    }
    const outs = outgoing.get(n.id) ?? [];
    for (const p of spec.outputs) {
      const count = outs.filter((e) => e.from.port === p.name).length;
      if (count > def.limits.maxFanout) err('fanout_exceeded', `"${n.label ?? spec.label}"의 "${p.label}" 출력은 ${def.limits.maxFanout}곳까지만 연결할 수 있어요`, { nodeId: n.id });
    }
    if (n.kind === 'branch') {
      const handled = new Set<string>();
      for (const e of outs) { handled.add(e.from.port); if (e.when) handled.add(e.when); }
      if (!handled.has('else') && !(handled.has('true') && handled.has('false'))) {
        err('branch_unhandled', `분기 "${n.label ?? n.id}"는 참·거짓 두 갈래를 모두 연결하거나 else 연결이 있어야 해요`, { nodeId: n.id });
      }
    } else if (spec.outputs.length > 0 && outs.length === 0) {
      warn('dead_end', `"${n.label ?? spec.label}"의 결과가 어디에도 쓰이지 않아요`, { nodeId: n.id });
    }
  }

  const known = [...nodes.values()].filter((n) => isKnownKind(n.kind));
  if (!known.some((n) => n.kind === 'collect')) err('no_collect', '공고 수집 노드가 하나 이상 필요해요');
  if (!known.some((n) => NODE_CATALOG[n.kind as keyof typeof NODE_CATALOG].isOutput)) err('no_output', '내보내기 노드가 하나 이상 필요해요');

  const order = topologicalOrder(def);
  if (order.cyclic.length > 0) err('cycle', `순환 연결이 있어요: ${order.cyclic.join(', ')}`, { nodeId: order.cyclic[0] });

  const reached = new Set<string>();
  const stack = known.filter((n) => n.kind === 'collect').map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of outgoing.get(id) ?? []) stack.push(e.to.node);
  }
  for (const n of known) if (!reached.has(n.id)) err('unreachable', `"${n.label ?? n.id}"은(는) 수집 단계에서 이어지지 않아 실행되지 않아요`, { nodeId: n.id });

  return { ok: errors.length === 0, errors, warnings };
}

// 존재하는 노드 사이의 연결만으로 위상 정렬한다. cyclic: 순환에 막혀 정렬되지 못한 노드 ID.
export function topologicalOrder(def: WorkflowDefinition): { order: string[]; cyclic: string[] } {
  const ids = [...new Set(def.nodes.map((n) => n.id))];
  const idSet = new Set(ids);
  const indeg = new Map(ids.map((i) => [i, 0]));
  const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of def.edges) {
    if (!idSet.has(e.from.node) || !idSet.has(e.to.node)) continue;
    adj.get(e.from.node)!.push(e.to.node);
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  }
  const queue = ids.filter((i) => indeg.get(i) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of adj.get(id)!) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  return { order, cyclic: ids.filter((i) => !order.includes(i)) };
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, canonicalize(o[k])]));
  }
  return v;
}

// layout(편집기 좌표)은 실행 의미가 아니므로 해시에서 제외한다.
export function canonicalHash(def: WorkflowDefinition): string {
  const { layout: _layout, ...rest } = def;
  return createHash('sha256').update(JSON.stringify(canonicalize(rest))).digest('hex');
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

export function diffDefinitions(a: WorkflowDefinition, b: WorkflowDefinition): DefinitionChange[] {
  const out: DefinitionChange[] = [];
  const nodeName = (n: NodeDef) => n.label ?? (isKnownKind(n.kind) ? NODE_CATALOG[n.kind].label : n.kind);
  const am = new Map(a.nodes.map((n) => [n.id, n]));
  const bm = new Map(b.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) if (!am.has(n.id)) out.push({ target: 'node', op: 'added', id: n.id, summary: `단계 "${nodeName(n)}"을(를) 추가했어요` });
  for (const n of a.nodes) if (!bm.has(n.id)) out.push({ target: 'node', op: 'removed', id: n.id, summary: `단계 "${nodeName(n)}"을(를) 삭제했어요` });
  for (const n of b.nodes) {
    const o = am.get(n.id);
    if (!o) continue;
    const keys = new Set([...Object.keys(o.config), ...Object.keys(n.config)]);
    const changed = [...keys].filter((k) => !same(o.config[k], n.config[k])).sort();
    if (changed.length) out.push({ target: 'node', op: 'changed', id: n.id, keys: changed, summary: `"${nodeName(n)}"의 설정(${changed.join(', ')})을 바꿨어요` });
    if (o.kind !== n.kind) out.push({ target: 'node', op: 'changed', id: n.id, keys: ['kind'], summary: `"${nodeName(n)}"의 종류를 ${o.kind}에서 ${n.kind}(으)로 바꿨어요` });
    if (o.label !== n.label) out.push({ target: 'node', op: 'changed', id: n.id, keys: ['label'], summary: `단계 이름을 "${o.label ?? ''}"에서 "${n.label ?? ''}"(으)로 바꿨어요` });
    if (!same(o.retry, n.retry) || o.timeoutSeconds !== n.timeoutSeconds) out.push({ target: 'node', op: 'changed', id: n.id, keys: ['retry', 'timeoutSeconds'], summary: `"${nodeName(n)}"의 재시도/제한 시간을 바꿨어요` });
  }
  const label = (d: WorkflowDefinition, e: EdgeDef) => {
    const f = d.nodes.find((n) => n.id === e.from.node);
    const t = d.nodes.find((n) => n.id === e.to.node);
    return `${f ? nodeName(f) : e.from.node}(${e.from.port}) → ${t ? nodeName(t) : e.to.node}`;
  };
  const aem = new Map(a.edges.map((e) => [e.id, e]));
  const bem = new Map(b.edges.map((e) => [e.id, e]));
  for (const e of b.edges) {
    const o = aem.get(e.id);
    if (!o) out.push({ target: 'edge', op: 'added', id: e.id, summary: `연결을 추가했어요: ${label(b, e)}` });
    else if (!same(o, e)) out.push({ target: 'edge', op: 'changed', id: e.id, summary: `연결을 바꿨어요: ${label(b, e)}` });
  }
  for (const e of a.edges) if (!bem.has(e.id)) out.push({ target: 'edge', op: 'removed', id: e.id, summary: `연결을 삭제했어요: ${label(a, e)}` });
  const lim = (Object.keys(b.limits) as (keyof typeof b.limits)[]).filter((k) => a.limits[k] !== b.limits[k]);
  if (lim.length) out.push({ target: 'limits', op: 'changed', keys: lim, summary: `실행 한도를 바꿨어요: ${lim.map((k) => `${k} ${a.limits[k]}→${b.limits[k]}`).join(', ')}` });
  if (!same(a.approvalPolicy, b.approvalPolicy)) out.push({ target: 'policy', op: 'changed', summary: '승인 정책을 바꿨어요' });
  const meta = (['name', 'description', 'goal'] as const).filter((k) => a[k] !== b[k]);
  if (meta.length) out.push({ target: 'meta', op: 'changed', keys: [...meta], summary: `워크플로 정보(${meta.join(', ')})를 바꿨어요` });
  return out;
}
