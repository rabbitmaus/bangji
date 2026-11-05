// Workflow 스튜디오 e2e. 아래 접근 가능한 이름(accessible name)은 스튜디오 UI가 노출한다고 가정한 값이다.
// 실제 UI와 다르면 최종 검증자가 로케이터만 조정한다.
//  - nav 링크/버튼: 'Workflow 스튜디오'
//  - 템플릿: 콤보박스 '템플릿'(이력서가 필요 없는 '채용 공고 목록만') 선택 후 버튼 '새로 만들기'
//  - 단계 라벨 입력: textbox '단계 이름' (목록 편집기 첫 항목)
//  - 노드 추가: 버튼 '노드 추가' → 팔레트의 버튼/옵션 'mergeDedupe'
//  - 검증 오류: role=alert (배너)
//  - 연결되지 않은 노드를 추가한 뒤 '검증'하면 role=alert 배너가 나타난다
//  - AI 변경안 패널(항상 표시): 요청 입력 textbox 'AI 요청', 전송 버튼 '변경안 요청', 버튼 '적용'/'거절'
//  - 샘플 실행: 버튼 '샘플 실행', 노드별 상태는 role=status 항목
//  - 승인: 버튼 '승인', 실행: 버튼 '실행'
import { expect, test } from '@playwright/test';

test('Workflow 스튜디오: 템플릿 → 편집 → 검증 → AI 변경안 → 샘플 → 승인 → 실행', async ({ page }) => {
  expect((await page.request.post('/api/guest')).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('link', { name: 'Workflow 스튜디오' }).or(page.getByRole('button', { name: 'Workflow 스튜디오' })).first().click();

  await page.getByRole('combobox', { name: '템플릿' }).selectOption({ label: '채용 공고 목록만' });
  await page.getByRole('button', { name: '새로 만들기' }).click();

  const label = page.getByRole('textbox', { name: '단계 이름' }).first();
  await label.fill('공고 수집(수정)');
  await expect(label).toHaveValue('공고 수집(수정)');

  await page.getByRole('button', { name: '노드 추가' }).click();
  await page.getByRole('button', { name: /mergeDedupe/ }).click();
  await expect(page.getByRole('button', { name: /mergeDedupe 삭제|병합.*삭제|삭제/ }).last()).toBeVisible();

  await page.getByRole('button', { name: '검증' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();

  await page.getByRole('button', { name: /삭제$/ }).last().click();
  await page.getByRole('button', { name: '검증' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('textbox', { name: 'AI 요청' }).fill('중복 제거 단계를 수집 뒤에 넣어 줘');
  await page.getByRole('button', { name: '변경안 요청' }).click();
  await expect(page.getByRole('button', { name: '적용' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: '거절' })).toBeVisible();
  await page.getByRole('button', { name: '적용' }).click();

  await page.getByRole('button', { name: '샘플 실행' }).click();
  await expect(page.getByRole('status').first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: '승인' }).click();
  await page.getByRole('button', { name: '실행' }).click();
  await expect(page.getByText(/실행 중|완료|running|completed/).first()).toBeVisible({ timeout: 60_000 });
});
