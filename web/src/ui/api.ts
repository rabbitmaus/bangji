// 공개 API 클라이언트(TRD 8.1). 서버와 공유하는 코드는 없고 타입은 UI 쪽에서 따로 둔다.

export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  retryAfter?: number;
  body?: any;
  constructor(status: number, code: string, message: string, retryable: boolean, retryAfter?: number, body?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

export const PRECONDITION_MESSAGE = '다른 곳에서 바뀌었어요. 새로 불러올게요';

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 412 || e.code === 'precondition_failed') return PRECONDITION_MESSAGE;
    if (e.status === 429 || e.code === 'limit_exceeded')
      return `${e.message} ${e.retryAfter ? `(${e.retryAfter}초 뒤에 다시 시도해 주세요)` : ''}`.trim();
    if (e.status === 401) return '게스트 세션이 없어요. 홈에서 시작해 주세요.';
    return e.message;
  }
  return e instanceof Error ? e.message : '알 수 없는 오류가 발생했어요.';
}

export interface Result<T> {
  data: T;
  etag: string | null;
}

async function raw<T>(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const err = json?.error;
    const ra = res.headers.get('Retry-After');
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `요청에 실패했어요 (${res.status})`,
      !!err?.retryable,
      ra ? Number(ra) : undefined,
      json,
    );
  }
  return { data: (json ?? (text as unknown)) as T, etag: res.headers.get('ETag') };
}

const get = <T>(p: string) => raw<T>('GET', p).then((r) => r.data);
const post = <T>(p: string, body?: unknown, headers?: Record<string, string>) =>
  raw<T>('POST', p, { body: body ?? {}, headers }).then((r) => r.data);

// ---------- 타입 ----------
export type Decision = 'pass' | 'reject' | 'hold';
export type CriterionStatus = 'met' | 'not_met' | 'unknown';
export type HoldReason =
  | 'unknown' | 'quote_mismatch' | 'disagreement' | 'schema_failure' | 'input_truncated'
  | 'detail_missing' | 'injection_suspected' | 'review_hold' | 'timeout' | 'limit_reached';

export interface BBox { x: number; y: number; width: number; height: number }

export interface BrowserSession {
  id: string;
  url?: string;
  title?: string;
  pageStateId: string;
  seq?: number;
  screenshotUrl?: string;
  viewport?: { width: number; height: number };
  provider?: 'browserbase' | 'local';
}

/** 서버 스냅샷({sessionId,...})을 UI 세션 모양으로 바꾼다. */
export function toSession(s: any, fallbackId?: string): BrowserSession {
  return {
    id: s.sessionId ?? s.id ?? fallbackId,
    url: s.url,
    title: s.title,
    pageStateId: s.pageStateId,
    seq: s.seq,
    screenshotUrl: s.screenshotUrl,
    viewport: s.viewport,
    provider: s.provider,
  };
}

export type BrowserAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; dy: number }
  | { type: 'back' }
  | { type: 'reload' };

export interface RegionResult {
  bbox: BBox;
  container?: string;
  itemCount?: number;
  canParent?: boolean;
  canChild?: boolean;
  session: BrowserSession;
}

export interface Recommendation {
  id: string;
  rank: number;
  name: string;
  reason?: string;
  bbox: BBox;
  itemCount?: number;
  container?: string;
}
export interface Recommendations { items: Recommendation[]; structureOnly?: boolean }

export type SourceKind = 'demo' | 'external';
export interface ContractSource { kind: SourceKind; startUrl: string; allowedHosts: string[] }
export interface ContractField { key: string; selector: string; value: string; required: boolean }
export interface ContractLimits { maxItems: number; maxDetails: number; timeoutSeconds: number }
export interface ContractPreviewRequest {
  source: ContractSource;
  container: string;
  item?: string;
  fields?: ContractField[];
  sampleCount?: number;
}
export interface ContractDraft {
  source: ContractSource;
  container: string;
  item: string;
  fields: ContractField[];
  limits: ContractLimits;
}
export interface ContractPreview {
  container: string;
  item: string;
  fields: ContractField[];
  itemCount: number;
  rows: Record<string, string | null>[];
  mapping?: 'auto' | 'user';
  candidates?: Record<string, string[]>;
  warnings?: string[];
}
export interface Contract extends ContractDraft {
  contractId: string;
  id: string;
  version: number;
  status?: string;
}

export interface CriteriaCard {
  id: string;
  gate: 'rule' | 'semantic';
  kind: 'deadline' | 'experience' | 'location' | 'employmentType' | 'semantic';
  label: string;
  value: string;
  required: boolean;
}

export interface Fact {
  id: string;
  category: string;
  text: string;
  org?: string;
  role?: string;
  period?: { start?: string; end?: string };
  skills?: string[];
  numbers?: string[];
  sourceSpan?: string;
  needsCheck?: boolean;
  confirmed?: boolean;
  origin?: 'model' | 'user';
}
export interface Resume {
  resumeId: string;
  facts: Fact[];
  sentences?: { id: string; text: string }[];
  experienceYears?: number;
  etag?: string;
  manual?: boolean;
}

export interface CriterionResult {
  criterionId: string;
  label?: string;
  required?: boolean;
  status: CriterionStatus;
  quote?: string;
  quoteVerified?: boolean;
  factIds?: string[];
  note?: string;
}
export interface Verdict {
  itemKey: string;
  decision: Decision;
  fields?: Record<string, string | null>;
  detailUrl?: string;
  criteria?: CriterionResult[];
  holdReasons?: HoldReason[];
  injectionSuspected?: boolean;
  collectedAt?: string;
  contractVersion?: number;
  manual?: { decision: Decision; note?: string } | null;
  reviewChange?: { from: Decision; to: Decision; reason?: string } | null;
  etag?: string;
}
export type RunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export interface RunSummary {
  criteriaVersion?: number;
  failureSummary?: Record<string, number>;
  id: string;
  status: RunStatus;
  stage?: string;
  collectionStatus?: 'success' | 'empty' | 'failed';
  failureCode?: string;
  failureMessage?: string;
  contractId?: string;
  contractVersion?: number;
  baseRunId?: string | null;
  startedAt?: string;
  completedAt?: string;
  collectedAt?: string;
  total?: number;
  verdicts: Verdict[];
  readOnly?: boolean;
}
export interface RunDiff {
  changes: { itemKey: string; title?: string; before: Decision; after: Decision; reason?: string }[];
}

export interface RunRequest {
  contractId: string;
  contractVersion?: number;
  criteria: CriteriaCard[];
  resumeId: string;
  baseRunId?: string;
}

export interface EventEnvelope { seq: number; [k: string]: any }

export interface TailorSentence {
  sentenceId: string;
  section?: string;
  text: string;
  sourceFactIds: string[];
  requirementIds?: string[];
  changeType: 'kept' | 'reordered' | 'rephrased' | 'summarized';
  originalRefs: string[];
}
export interface Verification { sentenceId: string; status: 'verified' | 'unsupported'; reasons?: string[] }
export interface TailorChange {
  id: string;
  type: 'modified' | 'added' | 'removed' | 'reordered';
  sentenceId?: string;
  originalRefs?: string[];
}
export type ChoiceDecision = 'accept' | 'reject';

// ---------- 호출 ----------
export const api = {
  guest: () => post<{ workspaceId?: string }>('/api/guest'),
  demoSeedRun: () => get<any>('/api/demo/seed-run').then(seedToRun),
  deleteWorkspace: () => raw<unknown>('DELETE', '/api/workspace').then((r) => r.data),

  startBrowser: (b: { kind: 'demo' | 'url'; url?: string }) =>
    post<any>('/api/browser-sessions', { kind: b.kind, url: b.url }).then((s) => toSession(s)),
  browserAction: (id: string, a: BrowserAction & { pageStateId?: string }) =>
    post<any>(`/api/browser-sessions/${id}/actions`, a).then((s) => toSession(s, id)),
  region: (
    id: string,
    b: { mode: 'resolve' | 'parent' | 'child'; x?: number; y?: number; pageStateId: string },
  ): Promise<RegionResult> =>
    post<any>(`/api/browser-sessions/${id}/region`, b).then((r) => ({
      bbox: r.region?.rect,
      container: r.region?.selector,
      itemCount: r.region?.itemCount,
      canParent: r.region?.canWiden,
      canChild: r.region?.canNarrow,
      session: toSession(r, id),
    })),
  recommendations: (id: string): Promise<Recommendations> =>
    get<any>(`/api/browser-sessions/${id}/recommendations`).then((r) => ({
      items: (r.recommendations ?? []).map((c: any): Recommendation => ({
        id: `${c.rank}:${c.selector}`,
        rank: c.rank,
        name: c.label,
        reason: c.reason,
        bbox: c.rect,
        itemCount: c.itemCount,
        container: c.selector,
      })),
      structureOnly: (r.recommendations ?? []).every((c: any) => c.label === '구조 기반 추천'),
    })),
  previewContract: (b: ContractPreviewRequest) => post<ContractPreview>('/api/contracts/preview', b),
  saveContract: (b: ContractDraft) =>
    post<any>('/api/contracts', b).then((c): Contract => ({ ...c, id: c.contractId })),

  putFacts: (id: string, facts: Fact[], etag: string | undefined) =>
    raw<Resume>('PUT', `/api/resumes/${id}/facts`, {
      body: { facts },
      headers: etag ? { 'If-Match': etag } : {},
    }),

  startRun: (b: RunRequest, key: string) => post<{ id: string }>('/api/runs', b, { 'Idempotency-Key': key }),
  getRun: (id: string) => get<RunSummary>(`/api/runs/${id}`),
  cancelRun: (id: string) => post<unknown>(`/api/runs/${id}/cancel`),
  patchVerdict: (runId: string, itemKey: string, body: { decision: Decision | null; note?: string }, etag?: string) =>
    raw<Verdict>('PATCH', `/api/runs/${runId}/verdicts/${encodeURIComponent(itemKey)}`, {
      body,
      headers: etag ? { 'If-Match': etag } : {},
    }),
  reevaluate: (id: string, criteria?: CriteriaCard[]) => post<{ id: string }>(`/api/runs/${id}/reevaluate`, { criteria }),
  diff: (id: string, base: string) => get<RunDiff>(`/api/runs/${id}/diff?base=${encodeURIComponent(base)}`),

  startTailoring: (runId: string, itemKey: string, key: string) =>
    post<{ id: string }>(`/api/runs/${runId}/tailorings`, { itemKey, itemKeys: [itemKey] }, { 'Idempotency-Key': key }),
  editSentence: (id: string, sid: string, b: { text?: string; addFactIds?: string[]; addFact?: { text: string } }) =>
    post<{ sentence?: TailorSentence; verification?: Verification }>(`/api/tailorings/${id}/sentences/${sid}`, b),
  decide: (id: string, decisions: { changeId: string; decision: ChoiceDecision }[], approve: boolean) =>
    post<unknown>(`/api/tailorings/${id}/decisions`, { decisions, approve }),
  exportMarkdown: async (id: string): Promise<string> => {
    const res = await fetch(`/api/tailorings/${id}/export?format=md`, { credentials: 'same-origin' });
    if (!res.ok) {
      let j: any;
      try { j = await res.json(); } catch { /* ignore */ }
      throw new ApiError(res.status, j?.error?.code ?? 'http_error', j?.error?.message ?? '내보내기에 실패했어요', false);
    }
    return res.text();
  },

  startAssistant: (browserSessionId: string) =>
    post<{ assistantSessionId: string }>('/api/assistant/sessions', { browserSessionId }),
  workflowGraph: async (): Promise<string> => {
    const res = await fetch('/api/workflow-graph', { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'http_error', '워크플로 그래프를 불러오지 못했어요', false);
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      return j.mermaid ?? j.text ?? t;
    } catch {
      return t;
    }
  },
};

/** 데모 시드 결과(/api/demo/seed-run)를 RunSummary로 바꾼다. */
function seedToRun(d: any): RunSummary {
  const items: any[] = d.items ?? [];
  const labels: Record<string, string> = {};
  for (const c of d.criteria ?? []) labels[c.id] = c.text ?? c.id;
  const verdicts: Verdict[] = (d.verdicts ?? []).map((v: any) => {
    const it = items.find((i) => i.itemKey === v.itemKey) ?? {};
    return {
      itemKey: v.itemKey,
      decision: v.decision,
      fields: { company: it.company ?? null, title: it.title ?? null },
      criteria: (v.criteria ?? []).map((c: any): CriterionResult => ({
        criterionId: c.criterionId,
        label: labels[c.criterionId],
        status: c.result === 'pass' ? 'met' : c.result === 'fail' ? 'not_met' : 'unknown',
        quote: c.citation?.quote,
        quoteVerified: c.citation?.quoteVerified,
      })),
      holdReasons: v.holdReasons ?? [],
      injectionSuspected: !!v.injectionSuspected,
    };
  });
  return { id: 'demo', status: 'completed', total: verdicts.length, verdicts, readOnly: true };
}

export const HOLD_REASON_TEXT: Record<string, string> = {
  unknown: '공고에 판단할 정보가 없음',
  quote_mismatch: '근거 인용이 원문과 일치하지 않음',
  disagreement: '평가 간 판단이 다름',
  schema_failure: 'AI 응답 형식 오류',
  input_truncated: '본문이 길어 일부만 평가함',
  detail_missing: '상세 페이지를 수집하지 못함',
  injection_suspected: '원문에 AI 지시로 보이는 문구가 있음',
  review_hold: '검토 에이전트가 근거 부족을 지적함',
  timeout: '평가 시간 초과',
  limit_reached: '실행 한도에 도달해 평가하지 않음',
};

export const FIELD_LABELS: Record<string, string> = {
  company: '회사',
  title: '직무',
  experience: '경력',
  location: '지역',
  employmentType: '고용형태',
  deadline: '마감일',
  detailUrl: '상세 링크',
};
