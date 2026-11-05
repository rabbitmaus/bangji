import { expect, test, type Page } from '@playwright/test';

const criterion = { id: 'c1', gate: 'semantic', kind: 'semantic', label: '직무', value: '백엔드', required: true };
const fact = { id: 'F1', category: 'skill', text: 'Node.js 개발', sourceSpan: 'Node.js 개발', skills: [], numbers: [], origin: 'model', confirmed: false };
const saved = { step: 1, sourceKind: 'demo', url: '', criteriaText: '', criteria: [] };
const screenshot = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="white"/></svg>');
const field = { key: 'title', selector: 'h2', value: 'text', required: true };
const preview = { container: 'ul.jobs', item: 'li', fields: [field], itemCount: 2, rows: [{ title: '개발자' }], candidates: { title: ['h2'] } };
const snapshot = { sessionId: 'browser-1', pageStateId: 'page-1', url: 'http://example.com/jobs', screenshotUrl: screenshot, viewport: { width: 1280, height: 800 } };
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function openWizard(page: Page, patch: Record<string, unknown> = {}) {
  await page.addInitScript((state) => sessionStorage.setItem('bangji.wizard', JSON.stringify(state)), { ...saved, ...patch });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/guest') return route.fulfill({ json: { workspaceId: 'test' } });
    if (path === '/api/browser-sessions') return route.fulfill({ json: snapshot });
    if (path.endsWith('/recommendations')) return route.fulfill({ json: {
      recommendations: [{ rank: 1, label: '채용 목록', selector: 'ul.jobs', itemCount: 2, rect: { x: 100, y: 100, width: 900, height: 500 } }],
    } });
    if (path.endsWith('/region')) return route.fulfill({ json: {
      ...snapshot, region: { selector: 'ul.jobs', rect: { x: 100, y: 100, width: 900, height: 500 }, canWiden: true, canNarrow: true },
    } });
    if (path === '/api/contracts/preview') {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { ...preview, fields: body.fields?.length ? body.fields : preview.fields } });
    }
    if (path === '/api/contracts') return route.fulfill({ json: { contractId: 'contract-1', version: 1 } });
    if (path === '/api/resumes') return route.fulfill({
      contentType: 'text/event-stream',
      body: sse('resume.facts', { resumeId: 'resume-1', facts: [fact], etag: 'v1' }),
    });
    if (path === '/api/resumes/resume-1/facts') return route.fulfill({
      json: { resumeId: 'resume-1', facts: route.request().postDataJSON().facts, etag: 'v2' },
    });
    if (path === '/api/resumes/resume-1') return route.fulfill({ json: { resumeId: 'resume-1', facts: [fact], etag: 'v1' } });
    return route.fulfill({ status: 404, json: { error: { message: `Unexpected test request: ${path}` } } });
  });
  await page.goto('/#/wizard');
}

const steps = (page: Page) => page.getByRole('list', { name: '진행 단계' });

test('empty or incomplete criteria cannot bypass prerequisites, including restored run step', async ({ page }) => {
  await openWizard(page, { step: 5, contractId: 'contract-1', resumeId: 'resume-1', resumeConfirmed: true });
  await expect(page.getByRole('heading', { name: '조건 입력' })).toBeVisible();
  await expect(steps(page).getByRole('button', { name: /이력서/ })).toBeDisabled();
  await expect(steps(page).getByRole('button', { name: /실행/ })).toBeDisabled();
  await page.getByRole('button', { name: '의미 기준', exact: true }).click();
  await expect(page.getByRole('button', { name: '이력서 확인하기', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '값', exact: true }).fill('백엔드');
  await expect(page.getByRole('button', { name: '이력서 확인하기', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: /선별 기준을 자유롭게/ }).fill('새로운 조건');
  await expect(page.getByRole('button', { name: '이력서 확인하기', exact: true })).toBeDisabled();
  await expect(steps(page).getByRole('button', { name: /실행/ })).toBeDisabled();
});

test('collection survives back navigation, supports keyboard region selection, and invalidates changed sources', async ({ page }) => {
  await openWizard(page);
  await page.getByRole('button', { name: '화면 불러오기' }).click();
  await page.getByRole('button', { name: '영역 선택 모드', exact: true }).click();
  const screen = page.getByRole('button', { name: /^목록 영역 선택/ });
  await screen.focus();
  await screen.press('ArrowRight');
  const region = page.waitForRequest((r) => r.url().endsWith('/region'));
  await screen.press('Enter');
  expect((await region).postDataJSON()).toMatchObject({ mode: 'resolve', x: 670, y: 400 });
  await page.getByRole('button', { name: '저장하고 다음' }).click();
  await expect(page.getByRole('heading', { name: '조건 입력' })).toBeVisible();
  await steps(page).getByRole('button', { name: /수집처·영역/ }).click();
  await expect(page.getByRole('heading', { name: '③ 필드 확인' })).toBeVisible();
  await page.getByRole('radio', { name: '공개 URL', exact: true }).check();
  await expect(steps(page).getByRole('button', { name: /조건/ })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '③ 필드 확인' })).not.toBeVisible();
  await page.getByRole('textbox', { name: '수집처 URL' }).fill('not-a-url');
  await expect(page.getByRole('button', { name: '화면 불러오기' })).toBeDisabled();
});

test('editing confirmed facts revokes run access and saving locks navigation', async ({ page }) => {
  await openWizard(page, { step: 4, contractId: 'contract-1', criteria: [criterion] });
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/resumes');
  await page.getByRole('button', { name: '샘플 이력서 사용' }).click();
  expect((await request).postDataJSON()).toEqual({ sample: true, consent: true });
  await page.getByRole('button', { name: '사실 확인 완료' }).click();
  await expect(page.getByRole('button', { name: '실행', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '이전', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'F1 내용' })).toHaveValue('Node.js 개발');
  await page.getByRole('textbox', { name: 'F1 내용' }).fill('Node.js 서비스 개발');
  await expect(steps(page).getByRole('button', { name: /실행/ })).toBeDisabled();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/resumes/resume-1/facts', async (route) => {
    await waiting;
    await route.fulfill({ json: { resumeId: 'resume-1', facts: route.request().postDataJSON().facts, etag: 'v3' } });
  });
  await page.getByRole('button', { name: '사실 확인 완료' }).click();
  await expect(steps(page).getByRole('button', { name: /조건/ })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'F1 내용' })).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: '실행', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '설정 다시 보기' }).click();
  await expect(page.getByRole('heading', { name: '① 수집처' })).toBeVisible();
});

test('removing every field is not silently replaced by automatic mappings', async ({ page }) => {
  await openWizard(page);
  await page.getByRole('button', { name: '화면 불러오기' }).click();
  await page.getByRole('button', { name: '이 영역 사용' }).click();
  await page.getByRole('combobox', { name: '직무', exact: true }).selectOption('');
  await expect(page.getByRole('button', { name: '저장하고 다음' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /미리보기 갱신/ })).toBeDisabled();
  await expect(page.getByText('추출할 필드를 하나 이상 선택해 주세요.')).toBeVisible();
});
