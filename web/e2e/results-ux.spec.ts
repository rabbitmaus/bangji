import { expect, test, type Page } from '@playwright/test';

const run = {
  id: 'run_ux', status: 'completed', collectionStatus: 'success',
  verdicts: [{ itemKey: 'job-1', decision: 'pass', fields: { title: '백엔드 개발자' }, etag: 'v1', criteria: [] }],
};

function tailoring() {
  return {
    evaluationRunId: 'run_ux', status: 'awaiting_approval', head: { title: '백엔드 개발자' },
    originals: [{ id: 'O1', text: '원본 경력' }],
    sentences: [
      { sentenceId: 'S1', text: '검증된 경력', sourceFactIds: ['F1'], originalRefs: ['O1'], changeType: 'rephrased', status: 'verified' },
      { sentenceId: 'S2', text: '검증 대기 경력', sourceFactIds: [], originalRefs: [], changeType: 'rephrased', status: 'pending' },
    ],
    changes: [
      { id: 'C-S1', type: 'modified', sentenceId: 'S1', originalRefs: ['O1'] },
      { id: 'C-S2', type: 'added', sentenceId: 'S2', originalRefs: [] },
    ],
    decisions: { 'C-S1': 'accept' },
  };
}

async function mockTailoring(page: Page, snapshot = tailoring()) {
  await page.route('**/api/tailorings/tl_ux', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/tailorings/tl_ux/events', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: 'event: draft.completed\ndata: {"seq":1,"sentences":[]}\n\n',
  }));
}

test('결과 로드 재시도와 판정 필터의 빈 상태에서 복구할 수 있다', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/runs/run_ux', (route) => {
    attempts += 1;
    return route.fulfill(attempts === 1
      ? { status: 503, json: { error: { message: '일시적으로 결과를 불러올 수 없어요.' } } }
      : { json: run });
  });
  await page.goto('/#/runs/run_ux');
  await page.getByRole('button', { name: '다시 불러오기' }).click();
  await expect(page.getByRole('heading', { name: '백엔드 개발자' })).toBeVisible();
  const filter = page.getByRole('group', { name: '판정 필터' });
  await filter.getByRole('button', { name: '탈락 0' }).click();
  await expect(filter.getByRole('button', { name: '탈락 0' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('이 판정에 해당하는 공고가 없어요.')).toBeVisible();
  await page.getByRole('button', { name: '전체 결과 보기' }).click();
  await expect(filter.getByRole('button', { name: '전체 1' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '기준별 결과 보기' }).click();
  await expect(page.getByText('기준별 결과가 아직 없어요.')).toBeVisible();
  await page.getByRole('button', { name: '기준별 결과 접기' }).click();
  await expect(page.getByText('기준별 결과가 아직 없어요.')).toBeHidden();
});

test('수동 판정을 되돌리면 선택값도 자동 판정으로 돌아온다', async ({ page }) => {
  let manual: { decision: string; note: string } | null = { decision: 'reject', note: '직접 검토함' };
  await page.route('**/api/runs/run_ux', (route) => route.fulfill({
    json: { ...run, verdicts: [{ ...run.verdicts[0], manual, etag: manual ? 'v2' : 'v3' }] },
  }));
  await page.route('**/api/runs/run_ux/verdicts/job-1', (route) => {
    expect(route.request().postDataJSON().decision).toBeNull();
    manual = null;
    return route.fulfill({ json: { ...run.verdicts[0], manual } });
  });
  await page.goto('/#/runs/run_ux');
  await expect(page.getByRole('combobox', { name: '수동 판정 선택' })).toHaveValue('reject');
  await page.getByRole('button', { name: '되돌리기' }).click();
  await expect(page.getByRole('combobox', { name: '수동 판정 선택' })).toHaveValue('pass');
  await expect(page.getByRole('textbox', { name: '수동 판정 메모' })).toHaveValue('');
  await expect(page.getByText('자동 판정으로 되돌렸어요.')).toBeVisible();
});

test('저장된 검토를 복원하고 미검증 수락을 막으며 원래 실행으로 돌아간다', async ({ page }) => {
  await mockTailoring(page);
  await page.route('**/api/runs/run_ux', (route) => route.fulfill({ json: run }));
  await page.goto('/#/tailorings/tl_ux');
  const verified = page.getByRole('group', { name: 'S1 결정' });
  const pending = page.getByRole('group', { name: 'S2 결정' });
  await expect(verified.getByRole('radio', { name: '수락' })).toBeChecked();
  await expect(pending.getByRole('radio', { name: '수락' })).toBeDisabled();
  await verified.getByRole('radio', { name: '수락' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(verified.getByRole('radio', { name: '거절' })).toBeChecked();
  await page.getByRole('button', { name: '결과 보드로', exact: true }).click();
  await expect(page).toHaveURL(/#\/runs\/run_ux$/);
});

test('문장 저장 실패는 편집 내용을 보존하고 편집 중 내보내기를 막는다', async ({ page }) => {
  await mockTailoring(page);
  let attempts = 0;
  await page.route('**/api/tailorings/tl_ux/sentences/S1', (route) => {
    attempts += 1;
    return route.fulfill(attempts === 1
      ? { status: 503, json: { error: { message: '검증 서버에 연결하지 못했어요.' } } }
      : { json: { sentence: { ...tailoring().sentences[0], text: '수정한 경력' }, verification: { sentenceId: 'S1', status: 'verified' } } });
  });
  await page.goto('/#/tailorings/tl_ux');
  await page.getByRole('button', { name: '문장 수정' }).first().click();
  await page.getByRole('textbox', { name: 'S1 문장' }).fill('수정한 경력');
  await expect(page.getByRole('button', { name: 'Markdown 내보내기' })).toBeDisabled();
  await page.getByRole('button', { name: '다시 검증' }).click();
  await expect(page.getByText('검증 서버에 연결하지 못했어요.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'S1 문장' })).toHaveValue('수정한 경력');
  await page.getByRole('button', { name: '다시 검증' }).click();
  await expect(page.getByRole('textbox', { name: 'S1 문장' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'S1 결정' }).getByRole('radio', { name: '수락' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Markdown 내보내기' })).toBeEnabled();
});

test('내보내기 실패는 재승인 없이 복구하고 클립보드 실패를 알린다', async ({ page }) => {
  await mockTailoring(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
  });
  let approvals = 0;
  let exports = 0;
  await page.route('**/api/tailorings/tl_ux/decisions', (route) => {
    approvals += 1;
    expect(route.request().postDataJSON()).toEqual({
      approve: true,
      decisions: [{ changeId: 'C-S1', decision: 'accept' }, { changeId: 'C-S2', decision: 'reject' }],
    });
    return route.fulfill({ json: { status: 'completed' } });
  });
  await page.route('**/api/tailorings/tl_ux/export?format=md', (route) => {
    exports += 1;
    return route.fulfill(exports === 1
      ? { status: 503, json: { error: { message: '파일을 불러오지 못했어요.' } } }
      : { contentType: 'text/markdown', body: '# 승인된 맞춤 이력서\n검증된 경력' });
  });
  await page.goto('/#/tailorings/tl_ux');
  await page.getByRole('button', { name: 'Markdown 내보내기' }).click();
  await expect(page.getByText('파일을 불러오지 못했어요.')).toBeVisible();
  await page.getByRole('button', { name: '최종 파일 다시 불러오기' }).click();
  await expect(page.getByLabel('최종 이력서 내용')).toContainText('승인된 맞춤 이력서');
  expect(approvals).toBe(1);
  await page.getByRole('button', { name: '복사', exact: true }).click();
  await expect(page.getByText(/클립보드에 접근하지 못했어요/)).toBeVisible();
  await expect(page.getByText('클립보드에 복사했어요.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Markdown 내보내기' })).toBeEnabled();
});
