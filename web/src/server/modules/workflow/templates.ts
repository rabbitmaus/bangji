import type { EdgeDef, NodeDef, WorkflowDefinition } from './schema.js';

export interface TemplateParams {
  id?: string;
  name?: string;
  goal?: string;
  contractId?: string;
  sourceUrl?: string;
  criteriaSetId?: string;
  resumeId?: string;
  rules?: Record<string, unknown>[];
}

const baseLimits = () => ({ maxItems: 30, maxDetails: 12, maxModelCalls: 80, runSeconds: 240, maxFanout: 5 });
const policy = () => ({ requireApprovalBeforeRun: true as const, requireHumanReviewForArtifacts: true as const, forbidExternalSubmit: true as const });
const edge = (id: string, from: string, fp: string, to: string, tp: string, when?: EdgeDef['when']): EdgeDef =>
  ({ id, from: { node: from, port: fp }, to: { node: to, port: tp }, ...(when ? { when } : {}) });

function collectNode(id: string, p: TemplateParams, label = '공고 수집'): NodeDef {
  const config: Record<string, unknown> = {};
  if (p.contractId) config.contractId = p.contractId;
  if (p.sourceUrl) config.sourceUrl = p.sourceUrl;
  return { id, kind: 'collect', label, config };
}
const ruleNode = (p: TemplateParams): NodeDef => ({ id: 'rules', kind: 'ruleFilter', label: '규칙 필터', config: { rules: p.rules ?? [], ...(p.criteriaSetId ? { criteriaSetId: p.criteriaSetId } : {}) } });
const evalNode = (p: TemplateParams): NodeDef => ({
  id: 'evaluate', kind: 'evidenceEvaluate', label: '근거 평가',
  config: { ...(p.criteriaSetId ? { criteriaSetId: p.criteriaSetId } : {}), ...(p.resumeId ? { resumeId: p.resumeId } : {}) },
});

function make(p: TemplateParams, defaults: { id: string; name: string }, nodes: NodeDef[], edges: EdgeDef[], layout: Record<string, { x: number; y: number }>): WorkflowDefinition {
  return {
    schemaVersion: 1, id: p.id ?? defaults.id, name: p.name ?? defaults.name, revision: 0,
    ...(p.goal ? { goal: p.goal } : {}), nodes, edges, limits: baseLimits(), approvalPolicy: policy(), layout,
  };
}

export function jobsToResumeTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make(p, { id: 'jobs-to-resume', name: '공고 수집 → 이력서 맞춤' }, [
    collectNode('collect', p), ruleNode(p), evalNode(p),
    { id: 'review', kind: 'humanReview', label: '사람 검토', config: {} },
    { id: 'tailor', kind: 'tailor', label: '이력서 맞춤', config: p.resumeId ? { resumeId: p.resumeId } : {} },
    { id: 'exportDocs', kind: 'exportMarkdown', label: '맞춤 문서', config: {} },
    { id: 'exportList', kind: 'exportList', label: '보류·제외 목록', config: {} },
  ], [
    edge('e1', 'collect', 'out', 'rules', 'in'),
    edge('e2', 'rules', 'out', 'evaluate', 'in'),
    edge('e3', 'evaluate', 'pass', 'review', 'in', 'pass'),
    edge('e4', 'review', 'approved', 'tailor', 'in'),
    edge('e5', 'tailor', 'out', 'exportDocs', 'in'),
    edge('e6', 'evaluate', 'hold', 'exportList', 'in', 'hold'),
    edge('e7', 'evaluate', 'reject', 'exportList', 'in', 'reject'),
  ], {
    collect: { x: 0, y: 120 }, rules: { x: 240, y: 120 }, evaluate: { x: 480, y: 120 },
    review: { x: 720, y: 40 }, tailor: { x: 960, y: 40 }, exportDocs: { x: 1200, y: 40 }, exportList: { x: 720, y: 220 },
  });
}

export function jobsListOnlyTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make(p, { id: 'jobs-list-only', name: '공고 수집 → 목록' }, [
    collectNode('collect', p), ruleNode(p), evalNode(p),
    { id: 'exportList', kind: 'exportList', label: '공고 목록', config: {} },
  ], [
    edge('e1', 'collect', 'out', 'rules', 'in'),
    edge('e2', 'rules', 'out', 'evaluate', 'in'),
    edge('e3', 'evaluate', 'pass', 'exportList', 'in', 'pass'),
    edge('e4', 'evaluate', 'hold', 'exportList', 'in', 'hold'),
    edge('e5', 'evaluate', 'reject', 'exportList', 'in', 'reject'),
  ], { collect: { x: 0, y: 120 }, rules: { x: 240, y: 120 }, evaluate: { x: 480, y: 120 }, exportList: { x: 720, y: 120 } });
}

export function twoSourceMergeTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make(p, { id: 'two-source-merge', name: '두 곳 수집 → 합치기 → 목록' }, [
    collectNode('collectA', p, '수집 A'), collectNode('collectB', { ...p, contractId: undefined, sourceUrl: undefined }, '수집 B'),
    { id: 'merge', kind: 'mergeDedupe', label: '합치기·중복 제거', config: { keyFields: ['url'] } },
    ruleNode(p), evalNode(p),
    { id: 'review', kind: 'humanReview', label: '보류 검토', config: {} },
    { id: 'exportList', kind: 'exportList', label: '공고 목록', config: {} },
  ], [
    edge('e1', 'collectA', 'out', 'merge', 'in'),
    edge('e2', 'collectB', 'out', 'merge', 'in'),
    edge('e3', 'merge', 'out', 'rules', 'in'),
    edge('e4', 'rules', 'out', 'evaluate', 'in'),
    edge('e5', 'evaluate', 'hold', 'review', 'in', 'hold'),
    edge('e6', 'review', 'approved', 'exportList', 'in'),
    edge('e7', 'evaluate', 'pass', 'exportList', 'in', 'pass'),
  ], {
    collectA: { x: 0, y: 40 }, collectB: { x: 0, y: 200 }, merge: { x: 240, y: 120 }, rules: { x: 480, y: 120 },
    evaluate: { x: 720, y: 120 }, review: { x: 960, y: 200 }, exportList: { x: 1200, y: 120 },
  });
}

export function reviewFirstListTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make(p, { id: 'review-first-list', name: '정규화 → 평가 → 사람 검토 → 목록' }, [
    collectNode('collect', p),
    { id: 'normalize', kind: 'normalizeFields', label: '필드 정리', config: {} },
    ruleNode(p), evalNode(p),
    { id: 'review', kind: 'humanReview', label: '통과 공고 검토', config: {} },
    { id: 'exportList', kind: 'exportList', label: '검토된 공고 목록', config: {} },
  ], [
    edge('e1', 'collect', 'out', 'normalize', 'in'),
    edge('e2', 'normalize', 'out', 'rules', 'in'),
    edge('e3', 'rules', 'out', 'evaluate', 'in'),
    edge('e4', 'evaluate', 'pass', 'review', 'in', 'pass'),
    edge('e5', 'review', 'approved', 'exportList', 'in'),
    edge('e6', 'evaluate', 'hold', 'exportList', 'in', 'hold'),
    edge('e7', 'evaluate', 'reject', 'exportList', 'in', 'reject'),
  ], {
    collect: { x: 0, y: 120 }, normalize: { x: 220, y: 120 }, rules: { x: 440, y: 120 }, evaluate: { x: 660, y: 120 },
    review: { x: 900, y: 40 }, exportList: { x: 1140, y: 120 },
  });
}

export function twoSourceResumeTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make(p, { id: 'two-source-resume', name: '두 곳 수집 → 합치기 → 이력서 맞춤' }, [
    collectNode('collectA', p, '수집 A'), collectNode('collectB', { ...p, contractId: undefined, sourceUrl: undefined }, '수집 B'),
    { id: 'merge', kind: 'mergeDedupe', label: '합치기·중복 제거', config: { keyFields: ['url'] } },
    ruleNode(p), evalNode(p),
    { id: 'review', kind: 'humanReview', label: '사람 검토', config: {} },
    { id: 'tailor', kind: 'tailor', label: '이력서 맞춤', config: p.resumeId ? { resumeId: p.resumeId } : {} },
    { id: 'exportDocs', kind: 'exportMarkdown', label: '맞춤 문서', config: {} },
    { id: 'exportList', kind: 'exportList', label: '보류·제외 목록', config: {} },
  ], [
    edge('e1', 'collectA', 'out', 'merge', 'in'),
    edge('e2', 'collectB', 'out', 'merge', 'in'),
    edge('e3', 'merge', 'out', 'rules', 'in'),
    edge('e4', 'rules', 'out', 'evaluate', 'in'),
    edge('e5', 'evaluate', 'pass', 'review', 'in', 'pass'),
    edge('e6', 'review', 'approved', 'tailor', 'in'),
    edge('e7', 'tailor', 'out', 'exportDocs', 'in'),
    edge('e8', 'evaluate', 'hold', 'exportList', 'in', 'hold'),
    edge('e9', 'evaluate', 'reject', 'exportList', 'in', 'reject'),
  ], {
    collectA: { x: 0, y: 40 }, collectB: { x: 0, y: 200 }, merge: { x: 220, y: 120 }, rules: { x: 440, y: 120 },
    evaluate: { x: 660, y: 120 }, review: { x: 900, y: 40 }, tailor: { x: 1120, y: 40 }, exportDocs: { x: 1340, y: 40 }, exportList: { x: 900, y: 220 },
  });
}

export function priceMonitorTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make({ goal: '상품 가격이 목표가 이하로 내려갔는지 확인해요', ...p }, { id: 'price-monitor', name: '상품 가격 모니터링' }, [
    collectNode('collect', p, '상품 페이지 수집'),
    { id: 'normalize', kind: 'normalizeFields', label: '가격·상품명 정리', config: { renames: { title: 'productName' } } },
    evalNode(p),
    { id: 'review', kind: 'humanReview', label: '목표가 도달 확인', config: {} },
    { id: 'exportList', kind: 'exportList', label: '가격 알림 목록', config: {} },
  ], [
    edge('e1', 'collect', 'out', 'normalize', 'in'),
    edge('e2', 'normalize', 'out', 'evaluate', 'in'),
    edge('e3', 'evaluate', 'pass', 'review', 'in', 'pass'),
    edge('e4', 'review', 'approved', 'exportList', 'in'),
    edge('e5', 'evaluate', 'hold', 'exportList', 'in', 'hold'),
    edge('e6', 'evaluate', 'reject', 'exportList', 'in', 'reject'),
  ], {
    collect: { x: 0, y: 120 }, normalize: { x: 240, y: 120 }, evaluate: { x: 480, y: 120 },
    review: { x: 720, y: 40 }, exportList: { x: 960, y: 120 },
  });
}

export function hackathonMonitorTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make({ goal: '마감이 남은 해커톤·대회를 모아 참가 조건에 맞는지 확인해요', ...p }, { id: 'hackathon-monitor', name: '해커톤·대회 모니터링' }, [
    collectNode('collectA', p, '대회 사이트 A'), collectNode('collectB', { ...p, contractId: undefined, sourceUrl: undefined }, '대회 사이트 B'),
    { id: 'merge', kind: 'mergeDedupe', label: '합치기·중복 제거', config: { keyFields: ['url'] } },
    { id: 'rules', kind: 'ruleFilter', label: '마감·지역 필터', config: { rules: p.rules ?? [{ criterion: 'deadline', required: true, params: {} }], ...(p.criteriaSetId ? { criteriaSetId: p.criteriaSetId } : {}) } },
    evalNode(p),
    { id: 'exportList', kind: 'exportList', label: '참가 후보 목록', config: {} },
  ], [
    edge('e1', 'collectA', 'out', 'merge', 'in'),
    edge('e2', 'collectB', 'out', 'merge', 'in'),
    edge('e3', 'merge', 'out', 'rules', 'in'),
    edge('e4', 'rules', 'out', 'evaluate', 'in'),
    edge('e5', 'evaluate', 'pass', 'exportList', 'in', 'pass'),
    edge('e6', 'evaluate', 'hold', 'exportList', 'in', 'hold'),
    edge('e7', 'evaluate', 'reject', 'exportList', 'in', 'reject'),
  ], {
    collectA: { x: 0, y: 40 }, collectB: { x: 0, y: 200 }, merge: { x: 240, y: 120 }, rules: { x: 480, y: 120 },
    evaluate: { x: 720, y: 120 }, exportList: { x: 960, y: 120 },
  });
}

export function emptyTemplate(p: TemplateParams = {}): WorkflowDefinition {
  return make(p, { id: 'empty', name: '새 워크플로' }, [
    collectNode('collect', p), { id: 'exportList', kind: 'exportList', label: '공고 목록', config: {} },
  ], [edge('e1', 'collect', 'out', 'exportList', 'in')], { collect: { x: 0, y: 80 }, exportList: { x: 260, y: 80 } });
}
