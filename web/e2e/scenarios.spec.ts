import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { card, DEMO_PRESET, seedRun, waitRunDone } from './helpers';

// TRD 12.2. 버튼은 역할과 이름으로 찾는다.
const COMPANY = { D1: '청솔소프트', D2: '한결테크', D3: '다온랩', D4: '미르커머스', D5: '대성시스템', D6: '새벽앱스', D7: '누리데이터', D8: '푸른길컴퍼니' };

test.describe.serial('PRD 3장 경로 전체 · 인젝션 · 맞춤 이력서', () => {
  let runUrl = '';
  let guestCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

  test.beforeEach(async ({ context }) => {
    await context.addCookies(guestCookies);
  });

  test('데모로 시작 → 추천 영역 → 저장 → 프리셋 → 샘플 이력서 → 실행', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '데모로 바로 시작' }).click();
    await expect(page.getByRole('heading', { name: '설정 마법사' })).toBeVisible();

    await page.getByRole('button', { name: '화면 불러오기' }).click();
    await expect(page.getByRole('heading', { name: /추천 영역/ })).toBeVisible();
    await page.getByRole('button', { name: '이 영역 사용' }).first().click();
    await expect(page.getByRole('heading', { name: '③ 필드 확인' })).toBeVisible();
    await expect(page.getByText('반복 항목 12건').first()).toBeVisible();
    await page.getByRole('button', { name: '저장하고 다음' }).click();
    await expect(page.getByRole('heading', { name: '조건 입력', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '데모 프리셋 적용' }).click();
    await expect(page.getByText('규칙 Gate · 마감일')).toBeVisible();
    await expect(page.locator('textarea').first()).toHaveValue(DEMO_PRESET);
    await page.getByRole('button', { name: '이력서 확인하기', exact: true }).click();

    await page.getByRole('button', { name: '샘플 이력서 사용' }).click();
    await expect(page.getByRole('heading', { name: '사실 목록 확인' })).toBeVisible();
    await page.getByRole('button', { name: '사실 확인 완료' }).click();

    await page.getByRole('button', { name: '실행', exact: true }).click();
    await expect(page).toHaveURL(/#\/runs\/erun_/);
    runUrl = page.url();
    guestCookies = await page.context().cookies();
    await expect(page.getByText(/completed · |완료/).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('li.verdict')).toHaveCount(12, { timeout: 60_000 });

    for (const k of ['D4', 'D5', 'D6'] as const) await expect(card(page, COMPANY[k]).locator('.badge-reject').first()).toBeVisible();
    for (const k of ['D7', 'D8'] as const) await expect(card(page, COMPANY[k]).locator('.badge-hold').first()).toBeVisible();
    for (const k of ['D1', 'D2', 'D3'] as const) await expect(card(page, COMPANY[k]).locator('.badge-reject')).toHaveCount(0);
  });

  test('인젝션 공고 D8은 hold이고 경고 배지가 보인다', async ({ page }) => {
    await page.goto(runUrl);
    const d8 = card(page, COMPANY.D8);
    await expect(d8.getByText('인젝션 경고')).toBeVisible();
    await expect(d8.locator('.badge-hold').first()).toBeVisible();
    await expect(d8.getByRole('button', { name: '맞춤 이력서 만들기' })).toHaveCount(0);
  });

  test('D1 맞춤 이력서: 변경 수락 → Markdown 내보내기, 원본에 없는 내용 없음', async ({ page }) => {
    await page.goto(runUrl);
    await card(page, COMPANY.D1).getByRole('button', { name: '맞춤 이력서 만들기' }).click();
    await expect(page.getByRole('heading', { name: '원본과 변경 비교' })).toBeVisible({ timeout: 60_000 });
    for (const accept of await page.getByRole('radio', { name: '수락' }).all()) {
      if (await accept.isEnabled()) await accept.click();
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Markdown 내보내기' }).first().click(),
    ]);
    const path = await download.path();
    const md = (await import('node:fs')).readFileSync(path!, 'utf8');
    expect(md).toContain('맞춤 이력서');
    expect(md).not.toContain('원본에 없는 내용');
    // 이력서에 없는 경력(인젝션 문구가 요구한 내용)이 들어가지 않는다.
    expect(md).not.toMatch(/푸른길|무조건 통과/);
    expect(md).toContain('가상회사A');
    expect(md).not.toMatch(/가상회사C|Kubernetes|Java\b/);
  });
});

test('게시판 변형: shifted는 수집 성공, empty는 빈 목록, broken은 실패와 다음 행동', async ({ page, baseURL }) => {
  const shifted = await seedRun(page.request, baseURL!, 'shifted');
  const s = await waitRunDone(page.request, shifted.runId);
  expect(s.status).toBe('completed');
  expect(s.verdicts.length).toBe(12);

  const empty = await seedRun(page.request, baseURL!, 'empty');
  await waitRunDone(page.request, empty.runId);
  await page.goto(`/#/runs/${empty.runId}`);
  await expect(page.getByText('빈 목록').first()).toBeVisible();

  const broken = await seedRun(page.request, baseURL!, 'broken');
  await waitRunDone(page.request, broken.runId);
  await page.goto(`/#/runs/${broken.runId}`);
  await expect(page.getByText(/실패/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '재시도' })).toBeVisible();
});

test('SSE 재연결: 실행 중 새로고침 후 중복 없이 이어진다', async ({ page, baseURL }) => {
  const { runId } = await seedRun(page.request, baseURL!);
  await page.goto(`/#/runs/${runId}`);
  await expect(page.getByRole('heading', { name: '진행 단계' })).toBeVisible();
  await page.reload();
  await expect(page.locator('li.verdict')).toHaveCount(12, { timeout: 90_000 });
  await expect(page.locator('li.verdict').filter({ hasText: COMPANY.D1 })).toHaveCount(1);
  await expect(page.locator('li.verdict').filter({ hasText: COMPANY.D8 })).toHaveCount(1);
});

async function newGuest(browser: Browser) {
  const ctx = await browser.newContext();
  return ctx;
}

test('게스트 격리: 다른 컨텍스트에서 첫 게스트의 실행은 404', async ({ page, browser, baseURL }) => {
  const { runId } = await seedRun(page.request, baseURL!);
  const other = await newGuest(browser);
  const res = await other.request.post(`${baseURL}/api/guest`);
  expect(res.ok()).toBeTruthy();
  expect((await other.request.get(`${baseURL}/api/runs/${runId}`)).status()).toBe(404);
  const p = await other.newPage();
  await p.goto(`${baseURL}/#/runs/${runId}`);
  await expect(p.locator('li.verdict')).toHaveCount(0);
  await other.close();
});

test('데이터 삭제: 내 데이터 삭제 후 이전 실행에 접근할 수 없다', async ({ page, baseURL }) => {
  const { runId } = await seedRun(page.request, baseURL!);
  await page.goto('/');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '내 데이터 삭제' }).click();
  await expect(page.getByText('내 데이터를 삭제했어요.')).toBeVisible();
  const after = await page.request.get(`/api/runs/${runId}`);
  expect([401, 404]).toContain(after.status());
});

test.describe('360px 폭', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('핵심 버튼이 보이고 가로 스크롤이 없다', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '데모로 바로 시작' })).toBeVisible();
    await expect(page.getByRole('button', { name: '내 데이터 삭제' })).toBeVisible();
    const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noHScroll()).toBe(true);

    await page.getByRole('button', { name: '데모로 바로 시작' }).click();
    await expect(page.getByRole('button', { name: '화면 불러오기' })).toBeVisible();
    expect(await noHScroll()).toBe(true);
  });
});
