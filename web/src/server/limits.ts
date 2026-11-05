import { ApiError, type Config } from './context.js';

const HOUR = 3600_000;

export class Limits {
  private runs = new Map<string, number[]>();
  private preps = new Map<string, number[]>();
  private assistants = new Map<string, number[]>();
  private guests = new Map<string, number[]>();
  private browserSessions = 0;
  constructor(private limits: Config['limits'], private now: () => number = Date.now) {}

  // 윈도우 내 기록을 세고, 한도 안이면 기록을 추가한다.
  private hit(map: Map<string, number[]>, key: string, max: number, message: string): void {
    const t = this.now();
    const arr = (map.get(key) ?? []).filter((x) => t - x < HOUR);
    if (arr.length >= max) {
      const retry = Math.max(1, Math.ceil((arr[0]! + HOUR - t) / 1000));
      map.set(key, arr);
      throw new ApiError(429, 'rate_limited', message, true, { 'Retry-After': String(retry) });
    }
    arr.push(t);
    map.set(key, arr);
  }

  assertGuestAllowed(ip: string): void {
    this.hit(this.guests, ip, this.limits.guestsPerIpHour, '잠시 후 다시 시도해 주세요. 이 네트워크에서 만들 수 있는 게스트 수를 넘었어요');
  }
  assertRunAllowed(workspaceId: string): void {
    this.hit(this.runs, workspaceId, this.limits.runsPerHour, '한 시간에 실행할 수 있는 횟수를 넘었어요. 잠시 후 다시 시도해 주세요');
  }
  assertPrepAllowed(workspaceId: string): void {
    this.hit(this.preps, workspaceId, this.limits.prepPerHour ?? 30, '한 시간에 준비 작업(이력서·조건 정리)을 할 수 있는 횟수를 넘었어요. 잠시 후 다시 시도해 주세요');
  }
  assertAssistantAllowed(workspaceId: string): void {
    this.hit(this.assistants, workspaceId, this.limits.assistantPerHour ?? 40, '한 시간에 도우미와 나눌 수 있는 대화 횟수를 넘었어요. 잠시 후 다시 시도해 주세요');
  }
  assertBrowserSessionAllowed(): void {
    if (this.browserSessions >= this.limits.browserSessions) {
      throw new ApiError(429, 'browser_busy', '지금 브라우저가 모두 사용 중이에요. 잠시 기다렸다가 다시 시도해 주세요', true, { 'Retry-After': '15' });
    }
    this.browserSessions++;
  }
  releaseBrowserSession(): void {
    this.browserSessions = Math.max(0, this.browserSessions - 1);
  }
}

let shared: Limits | undefined;
export function initLimits(limits: Config['limits']): Limits {
  shared = new Limits(limits);
  return shared;
}
export function getLimits(): Limits {
  if (!shared) throw new Error('limits not initialized');
  return shared;
}
