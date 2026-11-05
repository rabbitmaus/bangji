import { describe, expect, it } from 'vitest';
import {
  canonicalHash, diffDefinitions, jobsListOnlyTemplate, jobsToResumeTemplate, topologicalOrder, twoSourceMergeTemplate, priceMonitorTemplate, hackathonMonitorTemplate, reviewFirstListTemplate, twoSourceResumeTemplate,
  validateDefinition, type WorkflowDefinition,
} from './contract.js';

const clone = (d: WorkflowDefinition): WorkflowDefinition => structuredClone(d);
const codes = (d: WorkflowDefinition, ctx?: { hasResumeFacts?: boolean }) => validateDefinition(d, ctx).errors.map((e) => e.code);

describe('templates', () => {
  it('모든 템플릿이 유효해요', () => {
    for (const t of [jobsToResumeTemplate(), jobsListOnlyTemplate(), twoSourceMergeTemplate(), reviewFirstListTemplate(), twoSourceResumeTemplate(), priceMonitorTemplate(), hackathonMonitorTemplate()]) {
      expect(validateDefinition(t, { hasResumeFacts: true }).errors).toEqual([]);
      expect(t.layout).toBeTruthy();
    }
  });
  it('이력서 템플릿은 이력서 사실이 없으면 거부돼요', () => {
    expect(codes(jobsToResumeTemplate(), { hasResumeFacts: false })).toContain('resume_facts_required');
  });
});

describe('validateDefinition', () => {
  it('금지/알 수 없는 노드', () => {
    const d = clone(jobsListOnlyTemplate());
    d.nodes.push({ id: 'x', kind: 'externalSubmit', config: {} }, { id: 'y', kind: 'nope', config: {} });
    const c = codes(d);
    expect(c).toContain('forbidden_kind');
    expect(c).toContain('unknown_kind');
  });
  it('중복 ID·끊긴 연결', () => {
    const d = clone(jobsListOnlyTemplate());
    d.nodes.push({ ...d.nodes[0] });
    d.edges.push({ id: 'bad', from: { node: 'collect', port: 'out' }, to: { node: 'ghost', port: 'in' } });
    const c = codes(d);
    expect(c).toContain('duplicate_node_id');
    expect(c).toContain('dangling_edge');
  });
  it('포트 타입 불일치와 필수 입력 누락', () => {
    const d = clone(jobsListOnlyTemplate());
    d.edges = d.edges.filter((e) => e.id !== 'e2');
    d.edges.push({ id: 'm', from: { node: 'collect', port: 'out' }, to: { node: 'exportList', port: 'in' } });
    expect(codes(d)).toContain('missing_input');
    const t = clone(jobsToResumeTemplate());
    t.edges.push({ id: 'm', from: { node: 'collect', port: 'out' }, to: { node: 'tailor', port: 'in' } });
    expect(codes(t)).toContain('port_type_mismatch');
  });
  it('순환 거부', () => {
    const d = clone(jobsListOnlyTemplate());
    d.nodes.push({ id: 'n1', kind: 'normalizeFields', config: {} }, { id: 'n2', kind: 'normalizeFields', config: {} });
    d.edges.push(
      { id: 'c1', from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } },
      { id: 'c2', from: { node: 'n2', port: 'out' }, to: { node: 'n1', port: 'in' } },
    );
    expect(codes(d)).toContain('cycle');
    expect(topologicalOrder(jobsToResumeTemplate()).cyclic).toEqual([]);
  });
  it('도달 불가 노드, 수집/출력 노드 필수', () => {
    const d = clone(jobsListOnlyTemplate());
    d.nodes = d.nodes.filter((n) => n.kind !== 'collect');
    d.edges = d.edges.filter((e) => e.from.node !== 'collect');
    expect(codes(d)).toContain('no_collect');
    const e = clone(jobsListOnlyTemplate());
    e.nodes = e.nodes.filter((n) => n.kind !== 'exportList');
    e.edges = [e.edges[0], e.edges[1]];
    expect(codes(e)).toContain('no_output');
  });
  it('승인 정책과 한도', () => {
    const d = clone(jobsListOnlyTemplate());
    d.approvalPolicy.requireApprovalBeforeRun = false;
    d.approvalPolicy.forbidExternalSubmit = false;
    d.limits.maxItems = 51;
    d.limits.maxFanout = 6;
    const c = codes(d);
    expect(c.filter((x) => x === 'policy_violation')).toHaveLength(2);
    expect(c.filter((x) => x === 'limit_exceeded')).toHaveLength(2);
  });
  it('분기는 양쪽 또는 else 필요', () => {
    const d = clone(jobsListOnlyTemplate());
    d.nodes.push({ id: 'br', kind: 'branch', config: {} });
    d.edges.push(
      { id: 'b1', from: { node: 'evaluate', port: 'pass' }, to: { node: 'br', port: 'in' } },
      { id: 'b2', from: { node: 'br', port: 'true' }, to: { node: 'exportList', port: 'in' } },
    );
    expect(codes(d)).toContain('branch_unhandled');
    d.edges.push({ id: 'b3', from: { node: 'br', port: 'true' }, to: { node: 'exportList', port: 'in' }, when: 'else' });
    expect(codes(d)).not.toContain('branch_unhandled');
  });
});

describe('hash & diff', () => {
  it('해시는 layout을 제외해요', () => {
    const a = jobsToResumeTemplate();
    const b = clone(a);
    b.layout = { collect: { x: 999, y: 999 } };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    b.limits.maxItems = 10;
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
  });
  it('diff는 노드·연결·설정 변경을 한국어로 알려줘요', () => {
    const a = jobsListOnlyTemplate();
    const b = clone(a);
    b.nodes.push({ id: 'n', kind: 'normalizeFields', config: {} });
    b.edges = b.edges.filter((e) => e.id !== 'e5');
    b.nodes.find((n) => n.id === 'rules')!.config = { rules: [{ criterion: 'deadline', required: true, params: {} }] };
    const ch = diffDefinitions(a, b);
    expect(ch.some((c) => c.target === 'node' && c.op === 'added' && c.id === 'n')).toBe(true);
    expect(ch.some((c) => c.target === 'edge' && c.op === 'removed' && c.id === 'e5')).toBe(true);
    expect(ch.find((c) => c.id === 'rules')?.keys).toEqual(['rules']);
    expect(ch.every((c) => c.summary.length > 0)).toBe(true);
    expect(diffDefinitions(a, clone(a))).toEqual([]);
  });
});
