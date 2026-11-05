import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const DEMO_PRESET = '마감 안 된 공고, 경력 3년으로 지원 가능, 서울·경기 또는 원격, 정규직, 백엔드·Node.js';
const CONTAINER = 'ul[data-list="jobs"]';

export interface SeededRun { runId: string; contractId: string; resumeId: string }

function sseEvents(text: string): { event: string; data: any }[] {
  return text.split('\n\n').flatMap((blk) => {
    const m = /event: (.+)\ndata: (.+)/.exec(blk);
    return m ? [{ event: m[1], data: JSON.parse(m[2]) }] : [];
  });
}

/** API만으로 계약·이력서·조건·실행을 만든다. 게스트 쿠키는 request 컨텍스트가 들고 있다. */
export async function seedRun(request: APIRequestContext, baseURL: string, variant = ''): Promise<SeededRun> {
  expect((await request.post('/api/guest')).ok()).toBeTruthy();
  const origin = new URL(baseURL);
  const source = (q: string) => ({ kind: 'demo', startUrl: `${origin.origin}/demo/jobs${q}`, allowedHosts: [origin.hostname] });

  const prev = await (await request.post('/api/contracts/preview', { data: { source: source(''), container: CONTAINER } })).json();
  const startUrl = variant ? source(`?variant=${variant}`) : source('');
  const contractRes = await request.post('/api/contracts', {
    data: {
      source: startUrl, container: prev.container, item: prev.item, fields: prev.fields,
      limits: { maxItems: 20, maxDetails: 10, timeoutSeconds: 120 },
    },
  });
  expect(contractRes.status()).toBe(201);
  const contract = await contractRes.json();

  const resumeRes = await request.post('/api/resumes', { data: { sample: true, consent: true } });
  const facts = sseEvents(await resumeRes.text()).find((e) => e.event === 'resume.facts')!.data;
  const confirm = await request.put(`/api/resumes/${facts.resumeId}/facts`, {
    headers: { 'If-Match': facts.etag },
    data: { facts: facts.facts.map((f: any) => ({ ...f, confirmed: true, needsCheck: false })) },
  });
  expect(confirm.ok()).toBeTruthy();

  const draftRes = await request.post('/api/criteria/draft', { data: { text: DEMO_PRESET, careerYears: facts.careerYears } });
  const draft = sseEvents(await draftRes.text()).find((e) => e.event === 'criteria.draft')!.data;

  const run = await request.post('/api/runs', {
    headers: { 'Idempotency-Key': `e2e-${Date.now()}-${Math.random()}` },
    data: { contractId: contract.contractId, resumeId: facts.resumeId, criteriaSetId: draft.criteriaSetId },
  });
  expect(run.status()).toBe(202);
  return { runId: (await run.json()).runId, contractId: contract.contractId, resumeId: facts.resumeId };
}

export async function waitRunDone(request: APIRequestContext, runId: string) {
  await expect.poll(async () => (await (await request.get(`/api/runs/${runId}`)).json()).status, { timeout: 90_000 }).not.toBe('running');
  return (await request.get(`/api/runs/${runId}`)).json();
}

export const card = (page: Page, company: string) => page.locator('li.verdict').filter({ hasText: company });
