// 모든 web 모듈이 공유하는 계약. 소유자: web-core. 다른 에이전트는 수정하지 말고 필요 시 보고만 한다.
import type { Router } from 'express';

export interface Config {
  port: number;
  cookieSecret: string;
  copilotToken?: string;
  copilotModel?: string;
  evaluatorUrl: string;
  demoBoardOrigin: string;
  browserbaseApiKey?: string;
  limits: {
    maxItems: number; maxDetails: number; runSeconds: number; modelCalls: number;
    runsPerHour: number; prepPerHour?: number; assistantPerHour?: number; guestsPerIpHour: number; browserSessions: number;
  };
}

export interface Doc { id: string; type: string; workspaceId: string; _etag?: string; ttl?: number; [k: string]: unknown }

// Cosmos 파티션 키 = workspaceId. 구현: cosmos 또는 in-memory(로컬/테스트).
export interface DocStore {
  get<T extends Doc = Doc>(workspaceId: string, id: string): Promise<T | undefined>;
  upsert<T extends Doc>(doc: T): Promise<T>;                       // 결정적 ID upsert
  replaceIfMatch<T extends Doc>(doc: T, etag: string): Promise<T>;  // 불일치 시 PreconditionFailedError
  list<T extends Doc = Doc>(workspaceId: string, type: string, idPrefix?: string): Promise<T[]>;
  delete(workspaceId: string, id: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
}

export interface BlobStore {
  put(path: string, data: Buffer | string, contentType: string): Promise<void>;
  get(path: string): Promise<{ data: Buffer; contentType: string } | undefined>;
  deletePrefix(prefix: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false, public headers: Record<string, string> = {}) { super(message); }
}
export class PreconditionFailedError extends ApiError {
  constructor() { super(412, 'precondition_failed', '다른 곳에서 바뀌었어요. 새로 불러올게요'); }
}

declare global {
  namespace Express { interface Request { workspaceId?: string } }
}

export interface AppContext {
  config: Config;
  store: DocStore;
  blobs: BlobStore;
  // 한도 점검 헬퍼(web-core의 limits). 초과 시 ApiError(429) throw.
  assertRunAllowed(workspaceId: string): void;
  // 준비 단계(이력서 추출·조건 초안)와 도우미 대화는 실행 한도와 따로 센다.
  assertPrepAllowed?(workspaceId: string): void;
  assertAssistantAllowed?(workspaceId: string): void;
  assertBrowserSessionAllowed(): void;
  releaseBrowserSession(): void;
}

// 각 모듈은 src/server/modules/<name>/index.ts 에서 아래 시그니처로 export default 한다.
// 라우트는 `/api/...` 전체 경로로 등록(web-core가 게스트 쿠키 미들웨어를 /api 앞에 붙임).
export type RegisterModule = (router: Router, ctx: AppContext) => void | Promise<void>;
export const MODULE_NAMES = [
  'guest', 'demo', 'browser', 'contract', 'criteria', 'resume', 'runs', 'tailoring', 'assistant', 'workspace', 'workflow',
] as const;
