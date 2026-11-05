import { describe, expect, it } from 'vitest';
import { applyOps, buildProposalBody, checkOps, fakePlan, isStaleBase, type PatchOp } from './assistantPlan.js';
import { jobsToResumeTemplate, validateDefinition } from './contract.js';

const base = () => ({ ...jobsToResumeTemplate({ id: 'wf1' }), revision: 1 });

describe('applyOps', () => {
  it('노드·한도·이름 변경을 사본에 적용해요', () => {
    const b = base();
    const r = applyOps(b, [
      { op: 'updateLimits', limits: { maxItems: 10 } }, { op: 'rename', name: '새 이름' },
      { op: 'updateNode', id: 'review', label: '검토', config: { instruction: '확인' } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.definition.limits.maxItems).toBe(10);
      expect(r.definition.name).toBe('새 이름');
      expect(r.definition.nodes.find((n) => n.id === 'review')?.config.instruction).toBe('확인');
    }
    expect(b.limits.maxItems).toBe(30);
  });
  it('금지·알 수 없는 노드 종류와 알 수 없는 op를 거부해요', () => {
    for (const kind of ['code', 'externalSubmit', 'nope']) {
      expect(applyOps(base(), [{ op: 'addNode', node: { id: 'x', kind, config: {} } }]).ok).toBe(false);
    }
    expect(applyOps(base(), [{ op: 'setPolicy', value: false }]).ok).toBe(false);
  });
  it('승인 정책 변경과 한도 초과를 거부해요', () => {
    expect(applyOps(base(), [{ op: 'updateNode', id: 'review', config: { approvalPolicy: { requireApprovalBeforeRun: false } } }]).ok).toBe(false);
    expect(applyOps(base(), [{ op: 'updateLimits', limits: { maxItems: 9999 } }]).ok).toBe(false);
    expect(applyOps(base(), [{ op: 'updateLimits', limits: { approvalPolicy: 1 } as never }]).ok).toBe(false);
  });
  it('검증 오류를 모델이 고칠 수 있게 돌려줘요', () => {
    const c = checkOps(base(), [{ op: 'removeNode', id: 'evaluate' }]);
    expect(c.ok).toBe(false);
    expect(c.errors.length).toBeGreaterThan(0);
  });
});

describe('fakePlan', () => {
  for (const msg of ['중복을 제거해줘', '사람 검토 추가', '이력서 맞춤도 해줘', '목록으로 내보내기', '공고 15건으로 제한', '중복 제거하고 검토하고 20건 제한']) {
    it(`"${msg}" 변경안이 유효해요`, () => {
      const b = base();
      const p = fakePlan(b, msg);
      const body = buildProposalBody(b, p.ops as PatchOp[], p.rationale);
      expect('errors' in body ? body.errors : []).toEqual([]);
      const r = applyOps(b, p.ops);
      expect(r.ok && validateDefinition(r.definition).ok).toBe(true);
    });
  }
  it('같은 입력에 같은 결과를 내요', () => {
    expect(fakePlan(base(), '중복 제거')).toEqual(fakePlan(base(), '중복 제거'));
  });
});

describe('isStaleBase', () => {
  it('최신 revision과 다르면 오래된 것으로 봐요', () => {
    expect(isStaleBase(1, 1)).toBe(false);
    expect(isStaleBase(1, 2)).toBe(true);
  });
});
