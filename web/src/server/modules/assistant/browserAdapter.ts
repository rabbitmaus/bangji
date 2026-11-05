// 브라우저 모듈(다른 에이전트)의 세션 접근을 감싸는 얇은 어댑터. 시그니처가 다르면 여기만 고친다.
import { getSession } from '../browser/sessions.js';

export interface PageLike {
  evaluate<R, A = unknown>(fn: (arg: A) => R, arg?: A): Promise<R>;
}

export async function getPage(workspaceId: string, browserSessionId: string): Promise<PageLike | undefined> {
  const s: any = await (getSession as any)(workspaceId, browserSessionId);
  return s?.page ?? (typeof s?.evaluate === 'function' ? s : undefined);
}
