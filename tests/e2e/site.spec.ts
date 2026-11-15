import { expect, test } from '@playwright/test';

test('a apresentação do Malha funciona em celular com movimento reduzido', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.goto('/site');
  expect(response?.ok()).toBe(true);
  expect(response?.headers()['x-robots-tag']).toBeUndefined();
  await expect(page.getByRole('heading', { level: 1, name: /A rede do campo/ })).toBeVisible();
  await expect(page.getByText('Dados de demonstração', { exact: true })).toBeVisible();

  const collectors = page.getByRole('button', { name: 'Coletores', exact: true });
  await collectors.focus();
  await page.keyboard.press('Enter');
  await expect(collectors).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Confira a última comunicação' })).toBeVisible();

  await page.getByText('Posso usar o inventário que já tenho em planilha?', { exact: true }).click();
  await expect(page.getByText(/Use um arquivo CSV em UTF-8/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole('link', { name: 'Abrir painel', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Visão geral das fazendas' })).toBeVisible();
});
