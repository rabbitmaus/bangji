import { z } from 'zod';
import type { NodeKind, PortType } from './schema.js';

export interface PortSpec { name: string; type: PortType; required?: boolean; multi?: boolean; label: string }
export interface NodeSpec {
  kind: NodeKind;
  label: string;
  description: string;
  supported: boolean;
  inputs: PortSpec[];
  outputs: PortSpec[];
  config: z.ZodType<Record<string, unknown>>;
  isOutput?: boolean;
  isSource?: boolean;
  needsResumeFacts?: boolean;
  defaultConfig: Record<string, unknown>;
}

export const ruleCardConfigSchema = z.object({
  criterion: z.enum(['deadline', 'experience', 'region', 'employment']),
  required: z.boolean().default(true),
  params: z.object({
    minYears: z.number().min(0).max(50).optional(),
    maxYears: z.number().min(0).max(50).optional(),
    allowedRegions: z.array(z.string()).optional(),
    allowRemote: z.boolean().optional(),
    employmentTypes: z.array(z.enum(['정규직', '계약직', '인턴', '프리랜서'])).optional(),
    notPast: z.boolean().optional(),
  }).default({}),
});

const obj = <T extends z.ZodRawShape>(s: T) => z.object(s) as unknown as z.ZodType<Record<string, unknown>>;

const itemsIn = (label = '공고 목록'): PortSpec => ({ name: 'in', type: 'items', required: true, label });
const itemsOut = (label = '공고 목록'): PortSpec => ({ name: 'out', type: 'items', label });

export const NODE_CATALOG: Record<NodeKind, NodeSpec> = {
  collect: {
    kind: 'collect', label: '공고 수집', supported: true, isSource: true,
    description: '수집 계약(사이트 규칙) 또는 URL에서 채용공고 목록을 가져와요',
    inputs: [], outputs: [itemsOut()],
    config: obj({ contractId: z.string().max(80).optional(), sourceUrl: z.string().url().max(500).optional(), keywords: z.array(z.string().max(60)).max(10).optional() }),
    defaultConfig: {},
  },
  mergeDedupe: {
    kind: 'mergeDedupe', label: '합치기·중복 제거', supported: true,
    description: '여러 수집 결과를 하나로 합치고 같은 공고를 한 번만 남겨요',
    inputs: [{ name: 'in', type: 'items', required: true, multi: true, label: '공고 목록들' }], outputs: [itemsOut()],
    config: obj({ keyFields: z.array(z.string().max(40)).min(1).max(5).default(['url']) }),
    defaultConfig: { keyFields: ['url'] },
  },
  normalizeFields: {
    kind: 'normalizeFields', label: '항목 정리', supported: true,
    description: '필드 이름을 바꾸고 날짜·경력 표기를 통일해요',
    inputs: [itemsIn()], outputs: [itemsOut()],
    config: obj({ renames: z.record(z.string(), z.string().max(40)).default({}), dateFormat: z.enum(['iso', 'ymd']).optional() }),
    defaultConfig: { renames: {} },
  },
  ruleFilter: {
    kind: 'ruleFilter', label: '규칙 필터', supported: true,
    description: '마감일·경력·지역·고용형태 같은 계산 가능한 조건으로 거릅니다',
    inputs: [itemsIn()], outputs: [itemsOut('조건을 통과한 공고')],
    config: obj({ rules: z.array(ruleCardConfigSchema).max(10).default([]), criteriaSetId: z.string().max(64).optional() }),
    defaultConfig: { rules: [] },
  },
  evidenceEvaluate: {
    kind: 'evidenceEvaluate', label: '근거 평가', supported: true,
    description: '자격·적합도·검토를 거쳐 공고마다 통과/보류/제외 판정을 내려요',
    inputs: [itemsIn()],
    outputs: [
      { name: 'pass', type: 'verdictItems', label: '통과' },
      { name: 'hold', type: 'verdictItems', label: '보류' },
      { name: 'reject', type: 'verdictItems', label: '제외' },
    ],
    config: obj({ criteriaSetId: z.string().max(64).optional(), resumeId: z.string().max(64).optional() }),
    defaultConfig: {},
  },
  branch: {
    kind: 'branch', label: '분기', supported: true,
    description: '판정이나 필드 값에 따라 참/거짓 두 갈래로 나눠요',
    inputs: [{ name: 'in', type: 'verdictItems', required: true, label: '판정된 공고' }],
    outputs: [
      { name: 'true', type: 'verdictItems', label: '참' },
      { name: 'false', type: 'verdictItems', label: '거짓' },
    ],
    config: obj({ on: z.enum(['verdict', 'field']).default('verdict'), field: z.string().max(40).optional(), equals: z.union([z.string(), z.number(), z.boolean()]).default('pass') }),
    defaultConfig: { on: 'verdict', equals: 'pass' },
  },
  humanReview: {
    kind: 'humanReview', label: '사람 검토', supported: true,
    description: '실행을 멈추고 사용자가 항목을 직접 승인하거나 제외하도록 기다려요',
    inputs: [{ name: 'in', type: 'verdictItems', required: true, label: '검토할 공고' }],
    outputs: [{ name: 'approved', type: 'verdictItems', label: '승인된 공고' }],
    config: obj({ instruction: z.string().max(300).optional() }),
    defaultConfig: {},
  },
  tailor: {
    kind: 'tailor', label: '이력서 맞춤', supported: true, needsResumeFacts: true,
    description: '통과한 공고마다 이력서 사실만 사용해 맞춤 문장을 만들어요',
    inputs: [{ name: 'in', type: 'verdictItems', required: true, label: '통과 공고' }],
    outputs: [{ name: 'out', type: 'artifact', label: '맞춤 결과' }],
    config: obj({ resumeId: z.string().max(64).optional(), maxPerItem: z.number().int().min(1).max(10).optional() }),
    defaultConfig: {},
  },
  exportMarkdown: {
    kind: 'exportMarkdown', label: '문서로 내보내기', supported: true, isOutput: true,
    description: '맞춤 결과를 마크다운 문서로 내보내요 (사용자 검토 후 사용)',
    inputs: [{ name: 'in', type: 'artifact', required: true, label: '맞춤 결과' }], outputs: [],
    config: obj({ title: z.string().max(80).optional() }),
    defaultConfig: {},
  },
  exportList: {
    kind: 'exportList', label: '목록으로 내보내기', supported: true, isOutput: true,
    description: '공고 목록과 판정 이유를 표로 내보내요',
    inputs: [{ name: 'in', type: 'items', required: true, multi: true, label: '공고 목록' }], outputs: [],
    config: obj({ title: z.string().max(80).optional() }),
    defaultConfig: {},
  },
};

export function isKnownKind(kind: string): kind is NodeKind {
  return Object.prototype.hasOwnProperty.call(NODE_CATALOG, kind);
}

// 출력 타입 → 입력 타입 연결 가능 여부 (판정 목록은 일반 목록으로도 쓸 수 있다)
export function portsCompatible(from: PortType, to: PortType): boolean {
  return from === to || (from === 'verdictItems' && to === 'items');
}

export function getNodeCatalogView() {
  return Object.values(NODE_CATALOG).map((s) => ({
    kind: s.kind, label: s.label, description: s.description, supported: s.supported,
    inputs: s.inputs, outputs: s.outputs, defaultConfig: s.defaultConfig,
    needsResumeFacts: !!s.needsResumeFacts, isOutput: !!s.isOutput, isSource: !!s.isSource,
  }));
}
