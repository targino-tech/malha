import { expect, test } from '@playwright/test';

test('a apresentação do Malha funciona em celular com movimento reduzido', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.goto('/site');
  expect(response?.ok()).toBe(true);
  expect(response?.headers()['x-robots-tag']).toBeUndefined();
  await expect(page.getByRole('heading', { level: 1, name: /A rede do campo/ })).toBeVisible();
  await expect(page.getByText('Ilustração', { exact: true })).toBeVisible();
  await expect(page.getByText('Dados de demonstração', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sem internet, nada se perde.' })).toBeVisible();

  const menu = page.getByRole('button', { name: 'Abrir menu' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Navegação do site' }).getByRole('link', { name: 'Planos' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toHaveAttribute('aria-expanded', 'false');

  const collectors = page.getByRole('button', { name: 'Coletores', exact: true });
  await collectors.focus();
  await page.keyboard.press('Enter');
  await expect(collectors).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Confira a última comunicação' })).toBeVisible();

  await page.getByText('Posso usar o inventário que já tenho em planilha?', { exact: true }).click();
  await expect(page.getByText(/Use um arquivo CSV em UTF-8/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole('link', { name: 'Já sou cliente', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entre no Malha' })).toBeVisible();
  await page.getByRole('link', { name: 'Entrar com Microsoft' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral das fazendas' })).toBeVisible();
});

test('o cadastro do site registra a solicitação uma única vez', async ({ page, request }) => {
  await page.goto('/site/planos');
  await page.getByRole('link', { name: /Solicitar Piloto/ }).click();
  await expect(page).toHaveURL(/plano=piloto/);
  await expect(page.getByRole('radio', { name: /Piloto/ })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));

  await page.getByLabel('Nome').fill('Maria Teste');
  await page.getByLabel('E-mail corporativo').fill('maria.silva@example.com');
  await page.getByLabel('Empresa ou grupo').fill('Grupo Exemplo');
  await page.getByLabel('Número de fazendas').fill('4');
  await page.getByRole('button', { name: 'Enviar cadastro' }).click();
  await expect(page.getByRole('button', { name: 'Enviar cadastro' })).toBeVisible();
  await page.getByLabel(/Autorizo o uso destes dados/).check();
  await page.getByRole('button', { name: 'Enviar cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Solicitação recebida' })).toBeVisible();

  const id = crypto.randomUUID();
  const body = { id, plan: 'grupo', name: 'Ana', email: 'ana@example.com', company: 'Grupo B', farms: 2, consent: true };
  const first = await request.post('/api/site/requests', { data: body });
  expect(first.status()).toBe(201);
  const retry = await request.post('/api/site/requests', { data: body });
  expect(retry.status()).toBe(201);
  const invalid = await request.post('/api/site/requests', { data: { ...body, id: crypto.randomUUID(), consent: false } });
  expect(invalid.status()).toBe(422);
  const bot = await request.post('/api/site/requests', { data: { ...body, id: crypto.randomUUID(), website: 'spam' } });
  expect(bot.status()).toBe(422);
});
