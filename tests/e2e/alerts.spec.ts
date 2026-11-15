import { expect, test } from '@playwright/test';

test('admin cadastra canais de alerta sem ver o token do bot de novo', async ({ page }) => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
  await page.goto('/');
  await page.getByRole('button', { name: 'Alertas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Alertas por Telegram e e-mail' })).toBeVisible();

  const form = page.getByRole('form', { name: 'Novo canal' });
  await form.getByLabel('Nome do canal').fill('Plantão de TI');
  await form.getByLabel('Token do bot').fill(token);
  await form.getByLabel('Chat ID').fill('-1001234567890');
  await form.getByLabel('Severidade mínima').selectOption('warning');
  await form.getByRole('button', { name: 'Cadastrar canal' }).click();

  const channels = page.getByRole('list', { name: 'Canais cadastrados' });
  const row = channels.getByRole('listitem').filter({ hasText: 'Plantão de TI' });
  await expect(row.getByText(/token ••••sawQ/)).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(form.getByLabel('Token do bot')).toHaveValue('');

  await row.getByRole('button', { name: 'Desativar' }).click();
  await expect(row.getByText('Desativado')).toBeVisible();

  await form.getByLabel('Tipo').selectOption('email');
  await form.getByLabel('Nome do canal').fill('Gerência');
  await form.getByLabel(/Destinatários/).fill('gerente@example.com, ti@example.com');
  await form.getByRole('button', { name: 'Cadastrar canal' }).click();
  const email = channels.getByRole('listitem').filter({ hasText: 'Gerência' });
  await expect(email.getByText(/gerente@example.com, ti@example.com/)).toBeVisible();

  // Sem SMTP configurado no demo, o teste de e-mail explica o que falta.
  await email.getByRole('button', { name: 'Enviar teste' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'MALHA_SMTP_URL' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Entregas de alertas' }).or(page.getByText('Nenhuma entrega'))).toBeVisible();
});
