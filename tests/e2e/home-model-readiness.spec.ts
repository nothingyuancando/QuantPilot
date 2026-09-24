import { expect, test } from 'playwright/test';

const qwen = 'local_qwen:qwen3.5-9b-q5km';
const direct = 'deepseek-v4-flash';
function status(models: string[] = []) {
  return { pi: { installed: true, checking: false, configured: models.length > 0, available: models.length > 0, models } };
}

test('unavailable selected model preserves input and makes no project or research writes', async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(projects|chat)/.test(request.url())) writes.push(request.url());
  });
  await page.route('**/api/projects', route => route.fulfill({ json: { success: true, data: [] } }));
  // An alternative working model must not enable the default Qwen.
  await page.route('**/api/settings/cli-status', route => route.fulfill({ json: status([direct]) }));
  await page.goto('/');
  await page.getByLabel('量化分析需求').fill('分析贵州茅台的历史趋势');
  await expect(page.getByRole('status').filter({ hasText: '所选模型尚未通过访问检查' })).toBeVisible();
  await page.getByLabel('提交任务').click();
  await expect(page.getByLabel('提交任务')).toBeEnabled();
  await expect(page.getByLabel('量化分析需求')).toHaveValue('分析贵州茅台的历史趋势');
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  const notice = page.getByRole('status').filter({ hasText: '所选模型尚未通过访问检查' });
  await expect(notice).toBeFocused();
  const bounds = await notice.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(64);
  expect(bounds!.y + bounds!.height).toBeLessThan(page.viewportSize()!.height - 64);
  await page.screenshot({ path: testInfo.outputPath('model-readiness.png') });
  await page.getByLabel('选择分析模型').click();
  await page.getByRole('option', { name: 'DeepSeek V4 Flash (Official Direct)', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新检查模型' })).toHaveCount(0);
  await expect(page.getByLabel('量化分析需求')).toHaveValue('分析贵州茅台的历史趋势');
});

test('status failure clears prior availability and retry recovers without losing the question', async ({ page }) => {
  let healthy = true;
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(projects|chat)/.test(request.url())) writes.push(request.url());
  });
  await page.route('**/api/projects', route => route.fulfill({ json: { success: true, data: [] } }));
  await page.route('**/api/settings/cli-status', route => healthy
    ? route.fulfill({ json: status([qwen]) })
    : route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '重新检查模型' })).toHaveCount(0);
  await page.getByLabel('量化分析需求').fill('比较两只 ETF 的波动');
  healthy = false;
  await page.getByLabel('提交任务').click();
  await expect(page.getByRole('status').filter({ hasText: '模型状态尚未确认' })).toBeVisible();
  expect(writes).toEqual([]);
  healthy = true;
  await page.getByRole('button', { name: '重新检查模型' }).click();
  await expect(page.getByRole('button', { name: '重新检查模型' })).toHaveCount(0);
  await expect(page.getByLabel('量化分析需求')).toHaveValue('比较两只 ETF 的波动');
});
