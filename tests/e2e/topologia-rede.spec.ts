import { expect, test } from '@playwright/test';

test('topologia mostra o grafo da fazenda, o detalhe com portas, o filtro de VLAN e a tabela alternativa', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Topologia' }).click();
  await expect(page.getByRole('heading', { name: 'Topologia da rede' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Fazenda', exact: true }).selectOption({ label: 'Fazenda Cerrado Alto' });

  const graph = page.getByRole('group', { name: 'Topologia de rede da Fazenda Cerrado Alto' });
  await expect(graph).toBeVisible();
  await expect(page.getByText('Dados fictícios').first()).toBeVisible();
  await expect(page.getByText('Porta a porta (duas portas identificadas)')).toBeVisible();
  await expect(page.getByText('Entre dispositivos (sem evidência das portas)')).toBeVisible();

  // Teclado: Tab entra no gateway, seta para baixo vai ao switch, Enter abre o detalhe.
  const gateway = graph.getByRole('button', { name: /^Gateway da sede, Gateway, Online/ });
  await gateway.focus();
  await expect(gateway).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const switchNode = graph.getByRole('button', { name: /^Switch do escritório, Switch/ });
  await expect(switchNode).toBeFocused();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('complementary', { name: 'Switch do escritório' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText(/Gateway da sede, porta a porta \(porta 25 → porta 2\)/)).toBeVisible();
  const ports = page.getByRole('region', { name: 'Tabela de portas de Switch do escritório' });
  await expect(ports.getByRole('row')).toHaveCount(27);

  await page.getByRole('combobox', { name: 'Destacar VLAN' }).selectOption({ label: '40 · CFTV' });
  await expect(page.getByText(/equipamentos? levam? a VLAN 40/)).toBeVisible();
  await expect(ports.locator('tr[data-vlan]').first()).toBeVisible();

  await page.getByRole('button', { name: 'Ajustar à tela' }).click();
  await page.getByRole('button', { name: 'Ver tabela' }).click();
  const links = page.getByRole('region', { name: 'Tabela de ligações da topologia' });
  await expect(links.getByRole('row', { name: /AP da sede.*Entre dispositivos/ })).toBeVisible();
  await expect(links.getByRole('row', { name: /Switch do escritório.*Porta a porta/ })).toBeVisible();
  await page.getByRole('region', { name: 'Tabela de equipamentos da topologia' }).getByRole('button', { name: 'AP do armazém' }).click();
  await expect(page.getByRole('complementary', { name: 'AP do armazém' })).toBeVisible();
});

test('topologia funciona em tela estreita e com movimento reduzido', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Topologia' }).click();
  await page.getByRole('combobox', { name: 'Fazenda', exact: true }).selectOption({ label: 'Fazenda Três Pinheiros' });
  const graph = page.getByRole('group', { name: 'Topologia de rede da Fazenda Três Pinheiros' });
  await expect(graph.getByRole('button', { name: /Switch da balança, Switch, Offline/ })).toBeVisible();
  await graph.getByRole('button', { name: /Switch da balança/ }).click();
  await expect(page.getByRole('complementary', { name: 'Switch da balança' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});
