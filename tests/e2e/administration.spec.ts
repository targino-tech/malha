import { expect, test } from '@playwright/test';

test('admin cadastra fazenda, gera código do coletor e mantém um ativo manual', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Administração' }).click();
  await expect(page.getByRole('heading', { name: 'Administração do grupo' })).toBeVisible();

  const farmForm = page.getByRole('form', { name: 'Nova fazenda' });
  await farmForm.getByLabel('Nome da fazenda').fill('Fazenda Boa Esperança');
  await farmForm.getByLabel('Município · UF').fill('Lucas do Rio Verde · MT');
  await farmForm.getByRole('button', { name: 'Cadastrar fazenda' }).click();
  await expect(page.getByRole('list', { name: 'Fazendas cadastradas' }).getByText('Fazenda Boa Esperança')).toBeVisible();

  const memberForm = page.getByRole('form', { name: 'Novo membro' });
  await memberForm.getByLabel('Object ID (OID) no Entra ID').fill('3f1c2a9e-7b4d-4c1a-9e2f-5a6b7c8d9e0f');
  await memberForm.getByLabel('Nome de exibição').fill('Técnica Boa Esperança');
  await memberForm.getByLabel('Papel').selectOption('tecnico');
  await memberForm.getByLabel('Fazenda Boa Esperança').check();
  await memberForm.getByRole('button', { name: 'Adicionar membro' }).click();
  const members = page.getByRole('list', { name: 'Membros do grupo' });
  await expect(members.getByText('Técnica Boa Esperança')).toBeVisible();
  await expect(members.getByText('Técnico de fazenda · Fazenda Boa Esperança')).toBeVisible();

  await page.getByRole('button', { name: 'Integrações' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Fazenda Boa Esperança' });
  await row.getByRole('button', { name: 'Gerar código de ativação' }).click();
  const code = row.getByLabel('Código de ativação de Fazenda Boa Esperança');
  await expect(code).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  await expect(row.getByText('Aguardando ativação')).toBeVisible();

  await page.getByRole('button', { name: 'Inventário', exact: true }).click();
  await page.getByRole('button', { name: 'Novo ativo' }).click();
  const form = page.getByRole('dialog', { name: 'Novo ativo' });
  await form.getByLabel('Fazenda').selectOption({ label: 'Fazenda Boa Esperança' });
  await form.getByLabel('Nome', { exact: true }).fill('Antena do silo');
  await form.getByLabel('Categoria').fill('Antena');
  await form.getByLabel('Etiqueta patrimonial').fill('be-ant-01');
  await form.getByLabel('Local técnico').selectOption({ label: 'Novo local…' });
  await form.getByLabel('Nome do novo local').fill('Silo');
  await form.getByLabel('Ativo crítico').check();
  await form.getByRole('button', { name: 'Salvar ativo' }).click();

  const details = page.getByRole('dialog', { name: 'Antena do silo' });
  await expect(details.getByText('BE-ANT-01')).toBeVisible();
  await expect(details.getByText('Silo', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Editar' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar Antena do silo' });
  await edit.getByLabel('Responsável operacional').fill('Equipe de TI');
  await edit.getByRole('button', { name: 'Salvar ativo' }).click();
  await expect(page.getByRole('dialog', { name: 'Antena do silo' }).getByText('Equipe de TI')).toBeVisible();

  await page.getByRole('dialog', { name: 'Antena do silo' }).getByRole('button', { name: 'Arquivar' }).click();
  await expect(page.getByRole('dialog', { name: 'Antena do silo' }).locator('.asset-badges').getByText('Arquivado')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill('BE-ANT');
  await expect(page.getByText('Nenhum equipamento encontrado')).toBeVisible();
  await page.getByLabel('Arquivados').check();
  await expect(page.getByRole('button', { name: 'Antena do silo' })).toBeVisible();
});
