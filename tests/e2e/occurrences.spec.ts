import { expect, test } from '@playwright/test';

test('lista ocorrências do demo e registra o reconhecimento', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /ocorrências? abertas?/ })).toBeVisible();
  await page.getByRole('button', { name: 'Ver ocorrências' }).click();
  await expect(page.getByRole('heading', { name: 'Ocorrências', exact: true, level: 1 })).toBeVisible();
  const list = page.getByRole('list', { name: 'Lista de ocorrências' });
  await expect(list.getByText('Ativo offline: Switch do armazém')).toBeVisible();
  await expect(list.getByText('Coletor sem contato', { exact: true })).toBeVisible();

  const acknowledge = page.getByRole('button', { name: 'Reconhecer: Ativo offline: Switch do armazém' });
  const refresh = page.waitForResponse((response) => response.url().endsWith('/api/dashboard') && response.ok());
  await acknowledge.click();
  await refresh;
  await expect(acknowledge).toHaveCount(0);
  await expect(list.getByText(/^Reconhecida /).first()).toBeVisible();
});
