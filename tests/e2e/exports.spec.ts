import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('inventário, evidências e auditoria saem em planilha XLSX', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /^Inventário/ }).first().click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Planilha' }).click()]);
  expect(download.suggestedFilename()).toBe('malha-inventario.xlsx');
  const file = await readFile((await download.path())!);
  expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(file.length).toBeGreaterThan(5000);

  await page.getByRole('navigation').getByRole('button', { name: /^Indicadores/ }).first().click();
  const [evidence] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Evidências em planilha' }).click()]);
  expect(evidence.suggestedFilename()).toBe('malha-ocorrencias.xlsx');

  await page.getByRole('navigation').getByRole('button', { name: /^Auditoria/ }).first().click();
  const [audit] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Planilha de 90 dias' }).click()]);
  expect(audit.suggestedFilename()).toBe('malha-auditoria.xlsx');
});
