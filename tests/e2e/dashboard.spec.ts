import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('valida CSV, confirma a importação e localiza o ativo na fazenda escolhida', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral das fazendas' })).toBeVisible();
  await expect(page.getByText('Dados de demonstração')).toBeVisible();
  expect(await page.getByLabel('Filtrar por fazenda').locator('option').count()).toBeGreaterThan(2);

  await page.getByRole('button', { name: 'Importações' }).click();
  const farm = page.getByLabel('Fazenda de destino').locator('option').nth(1);
  const farmId = await farm.getAttribute('value');
  expect(farmId).toBeTruthy();
  await page.getByLabel('Fazenda de destino').selectOption(farmId!);

  const file = page.getByLabel('Arquivo CSV');
  await file.setInputFiles({ name: 'invalido.csv', mimeType: 'text/csv', buffer: Buffer.from('etiqueta,nome,categoria\nE2E,,Tablet\n') });
  await page.getByRole('button', { name: 'Validar arquivo' }).click();
  await expect(page.getByText('Corrija os erros antes de importar.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirmar importação' })).toHaveCount(0);

  await file.setInputFiles({ name: 'inventario.csv', mimeType: 'text/csv', buffer: readFileSync('examples/inventario.csv') });
  await page.getByRole('button', { name: 'Validar arquivo' }).click();
  await expect(page.getByRole('heading', { name: 'Prévia do lote' })).toBeVisible();
  await expect(page.getByText('Balança de entradas')).toBeVisible();
  const refresh = page.waitForResponse((response) => response.url().endsWith('/api/dashboard') && response.ok());
  await page.getByRole('button', { name: 'Confirmar importação' }).click();
  await expect(page.getByText('2 ativos importados.')).toBeVisible();
  await refresh;

  await page.getByRole('button', { name: 'Inventário', exact: true }).click();
  await page.getByLabel('Filtrar por fazenda').selectOption(farmId!);
  await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill('CAMPO-002');
  await page.getByRole('button', { name: 'Balança de entradas' }).click();
  await expect(page.getByRole('dialog', { name: 'Balança de entradas' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('192.0.2.20')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByLabel('Filtrar por fazenda').selectOption({ index: 2 });
  await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill('CAMPO-002');
  await expect(page.getByText('Nenhum equipamento encontrado')).toBeVisible();
});

test('o painel permanece utilizável em 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral das fazendas' })).toBeVisible();
  await page.getByRole('button', { name: 'Inventário', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Buscar equipamento' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
