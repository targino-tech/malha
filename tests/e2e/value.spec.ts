import { expect, test } from '@playwright/test';

test('linha de base, atendimento e indicadores de valor', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Indicadores' }).click();
  const cards = page.getByRole('list', { name: 'Indicadores de valor' });
  await expect(cards.getByText('Cobertura de coleta UniFi')).toBeVisible();
  await expect(cards.getByText('Tempo de detecção')).toBeVisible();

  const baseline = page.getByRole('form', { name: 'Linha de base' });
  await baseline.getByLabel('Diagnóstico antes do piloto (min)').fill('120');
  await baseline.getByLabel('Horas por viagem à fazenda').fill('4');
  await baseline.getByLabel('Custo por hora técnica (R$)').fill('80');
  await baseline.getByLabel('Custo por viagem (R$)').fill('350');
  await baseline.getByRole('button', { name: 'Salvar linha de base' }).click();
  await expect(cards.getByText('Defina a linha de base para calcular')).toHaveCount(0);

  await page.getByRole('button', { name: /^Ocorrências/ }).click();
  await page.getByRole('button', { name: 'Registrar atendimento: Ativo offline: Switch do armazém' }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar atendimento' });
  await dialog.getByLabel('Tempo de diagnóstico (min)').fill('30');
  await dialog.getByLabel('Viagem à fazenda evitada').check();
  await dialog.getByLabel('Observações').fill('Reinício remoto da porta PoE.');
  await dialog.getByRole('button', { name: 'Registrar' }).click();
  await expect(page.getByText('Atendimento registrado.')).toBeVisible();

  await page.getByRole('button', { name: 'Indicadores' }).click();
  await expect(cards.getByText('5,5 h')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Atendimentos registrados' }).getByText('Reinício remoto da porta PoE.')).toBeVisible();
});

test('conciliação, histórico do ativo, exportação segura e auditoria', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Conciliação' }).click();
  const reference = page.getByRole('list', { name: 'Cadastro a conferir' });
  await expect(reference.getByText('Balança do armazém')).toBeVisible();
  await page.getByRole('button', { name: 'Conferir Balança do armazém' }).click();
  await expect(reference.getByText('Balança do armazém')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Descobertos pela coleta' }).getByText('Gateway da unidade')).toBeVisible();

  await page.getByRole('button', { name: 'Inventário', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill('HZ-BAL-01');
  await page.getByRole('button', { name: 'Balança do armazém' }).click();
  const details = page.getByRole('dialog', { name: 'Balança do armazém' });
  await expect(details.getByRole('heading', { name: 'Histórico' })).toBeVisible();
  await expect(details.getByText('Conferido', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  const csv = await request.get('/api/exports/assets');
  expect(csv.ok()).toBe(true);
  expect(csv.headers()['content-disposition']).toContain('malha-inventario.csv');
  const body = await csv.text();
  expect(body.split('\r\n')[0]).toContain('fazenda;etiqueta;nome');

  await page.getByRole('button', { name: 'Auditoria' }).click();
  const log = page.getByRole('list', { name: 'Registros de auditoria' });
  await expect(log.getByText('Inventário exportado').first()).toBeVisible();
  await expect(log.getByText('Ativo conferido').first()).toBeVisible();
});
