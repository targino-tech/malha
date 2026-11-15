import { expect, test } from '@playwright/test';

test('painéis mostram os gráficos com tabela alternativa e navegação por teclado', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Painéis' }).first().click();
  await expect(page.getByRole('heading', { name: 'Painéis da operação' })).toBeVisible();
  const states = page.getByRole('region', { name: 'Estado dos ativos por fazenda' });
  await expect(states.getByLabel(/Fazenda Vale Verde: 2 em contato, 1 offline/)).toBeVisible();

  const daily = page.getByRole('group', { name: 'Ocorrências abertas por dia' });
  await daily.focus();
  await page.keyboard.press('End');
  await expect(page.locator('.viz-tooltip')).toBeVisible();

  const silent = page.getByRole('region', { name: 'Tempo sem contato por coletor' });
  await silent.getByRole('button', { name: 'Ver tabela' }).click();
  await expect(silent.getByRole('row', { name: /Fazenda Santa Luzia/ })).toBeVisible();
  await expect(silent.getByRole('button', { name: 'Ver gráfico' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('combobox', { name: 'Período' }).selectOption('7');
  await expect(page.getByText('Episódios abertos nos últimos 7 dias, por severidade.')).toBeVisible();
});
