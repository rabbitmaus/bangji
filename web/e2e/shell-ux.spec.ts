import { expect, test } from '@playwright/test';

test('본문 건너뛰기는 현재 화면과 경로를 유지한다', async ({ page }) => {
  await page.goto('/#/wizard');
  const skip = page.getByRole('link', { name: '본문으로 건너뛰기' });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/wizard$/);
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.getByRole('heading', { name: '설정 마법사' })).toBeVisible();
});

test('저장된 설정을 이어가고 새로 시작 취소 시 보존한다', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('bangji.wizard', JSON.stringify({
    step: 1, sourceKind: 'url', url: 'https://example.com/jobs', criteriaText: '', criteria: [],
  })));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '작성 중인 설정이 있어요' })).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: '데모로 바로 시작' }).click();
  await expect(page).not.toHaveURL(/#\/wizard/);
  await page.getByRole('button', { name: '이어서 설정하기' }).click();
  await expect(page).toHaveURL(/#\/wizard$/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('bangji.wizard')!).url))
    .toBe('https://example.com/jobs');
});

test('도우미는 수집처 준비를 안내하고 Escape로 닫힌 뒤 포커스를 돌려준다', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '설계 도우미', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: '설계 도우미' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: '도우미에게 보낼 메시지' })).toBeVisible();
  await expect(page.getByText('데모 수집처 화면을 자동으로 열고')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('워크플로 복사 실패를 알리고 텍스트를 보존한다', async ({ page }) => {
  await page.route('**/api/workflow*', (route) => route.fulfill({
    contentType: 'text/plain', body: 'graph TD; A-->B',
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => { throw new Error('복사 권한이 없어요.'); } },
    });
  });
  await page.goto('/#/workflow');
  await page.getByRole('button', { name: '복사', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('복사 권한이 없어요.');
  await expect(page.getByLabel('Mermaid 텍스트')).toContainText('graph TD');
});

for (const width of [320, 360, 1280]) {
  test(`${width}px에서 내비게이션과 도우미가 두 테마에서 화면에 들어온다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: '어두운 테마로 전환' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: '설계 도우미', exact: true }).click();
      for (const target of [
        page.getByRole('button', { name: '닫기', exact: true }),
        page.getByRole('link', { name: '설정 마법사', exact: true }),
        page.getByRole('textbox', { name: '도우미에게 보낼 메시지' }),
      ]) {
        await expect(target).toBeInViewport();
        const box = await target.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole('button', { name: '닫기', exact: true }).click();
    }
  });
}
