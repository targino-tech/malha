import { expect, test } from '@playwright/test';

// O mapa base externo fica bloqueado: o teste não depende da internet e exercita o fundo local.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/tiles\.openfreemap\.org\//, (route) => route.abort());
});

test('aba Mapa mostra fazendas, tabelas ordenáveis e CSP estreita para o mapa base', async ({ page, request }) => {
  const csp = (await request.get('/')).headers()['content-security-policy'];
  expect(csp).toContain("worker-src 'self'");
  expect(csp).toMatch(/connect-src 'self' https:\/\/tiles\.openfreemap\.org(;|$)/);
  expect(csp).not.toContain('*');
  expect((await request.get('/entrar')).headers()['content-security-policy']).not.toContain('openfreemap');

  const violations: string[] = [];
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Mapa', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mapa das fazendas' })).toBeVisible();

  const table = page.getByRole('region', { name: 'Tabela de fazendas do mapa' });
  await expect(table.getByRole('row', { name: /Fazenda Cerrado Alto/ })).toBeVisible();
  await expect(table.getByText('Rio Verde · GO · fictício')).toBeVisible();

  const traffic = table.getByRole('columnheader', { name: 'Tráfego' });
  await traffic.getByRole('button').click();
  await expect(traffic).toHaveAttribute('aria-sort', 'descending');
  await traffic.getByRole('button').press('Enter');
  await expect(traffic).toHaveAttribute('aria-sort', 'ascending');

  await page.getByRole('button', { name: 'Região' }).click();
  await expect(page.getByRole('region', { name: 'Indicadores por região' }).getByRole('rowheader', { name: 'Centro-Oeste' })).toBeVisible();

  await page.getByRole('radio', { name: 'Ocorrências abertas' }).check();
  await page.getByRole('slider').fill('2');
  await expect(page.getByText('últimos 30 dias').first()).toBeVisible();

  // Com WebGL 2, o MapLibre desenha sobre o contorno local; sem ele, a página explica e mantém as tabelas.
  const canvas = page.locator('.maplibregl-canvas');
  const fallback = page.getByText('O mapa interativo não está disponível neste navegador');
  await expect(canvas.or(fallback)).toBeVisible({ timeout: 20_000 });
  if (await canvas.isVisible()) {
    await expect(page.getByText('O mapa base não carregou.')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Ver Fazenda Cerrado Alto no mapa' }).click();
    await expect(page.locator('.maplibregl-popup').getByText('Fazenda Cerrado Alto')).toBeVisible();
  }
  expect(violations).toEqual([]);
});

test('o mapa permanece utilizável em 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Mapa', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tabela de fazendas do mapa' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
