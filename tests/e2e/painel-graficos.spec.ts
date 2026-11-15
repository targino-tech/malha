import { expect, test } from '@playwright/test';

test('painel de rede mostra indicadores, gráficos com tabela e navegação por teclado', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Painéis' }).first().click();
  await page.getByRole('group', { name: 'Conjunto de painéis' }).getByRole('button', { name: 'Rede' }).click();
  const kpis = page.getByRole('list', { name: 'Indicadores de rede' });
  await expect(kpis.getByText('Portas ativas')).toBeVisible();
  await expect(kpis.getByText('Dispositivos offline')).toBeVisible();
  await expect(page.getByText('Dados de rede fictícios')).toBeVisible();

  const traffic = page.getByRole('group', { name: 'Tráfego recebido e enviado' });
  await traffic.focus();
  await page.keyboard.press('End');
  await expect(page.locator('.net-area-plot .viz-tooltip')).toContainText('recebido (RX)');
  await expect(page.locator('.net-area-plot path[fill^="url(#"]').first()).toBeVisible();

  const heat = page.getByRole('group', { name: /Switch do escritório, Fazenda Cerrado Alto/ });
  await heat.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.net-heat-row .viz-tooltip')).toContainText('Porta 2');

  const vlans = page.getByRole('region', { name: 'Distribuição de VLANs' });
  await vlans.getByRole('button', { name: 'Ver tabela' }).click();
  await expect(vlans.getByRole('row', { name: /Produção/ })).toBeVisible();

  await page.getByRole('combobox', { name: 'Período' }).selectOption('7d');
  await expect(page.getByText(/últimos 7 dias, média por intervalo de 1 h/)).toBeVisible();

  await page.getByRole('combobox', { name: 'Filtrar por fazenda' }).selectOption({ label: 'Fazenda Três Pinheiros' });
  await expect(page.getByRole('region', { name: 'Tráfego por fazenda' }).getByRole('listitem')).toHaveCount(1);

  await page.getByRole('group', { name: 'Conjunto de painéis' }).getByRole('button', { name: 'Operação' }).click();
  await expect(page.getByRole('region', { name: 'Estado dos ativos por fazenda' })).toBeVisible();
});

test('API do painel de rede responde no demo e esconde fazenda inexistente', async ({ request }) => {
  const response = await request.get('/api/network/panel?period=7d');
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()['cache-control']).toContain('no-store');
  const panel = await response.json() as { synthetic: boolean; traffic: unknown[]; switches: unknown[] };
  expect(panel.synthetic).toBe(true);
  expect(panel.traffic.length).toBeGreaterThan(100);
  expect(panel.switches.length).toBeGreaterThan(0);
  expect((await request.get('/api/network/panel?farmId=00000000-0000-4000-8000-000000000999')).status()).toBe(404);
  expect((await request.get('/api/network/panel?period=1y')).status()).toBe(400);
});
