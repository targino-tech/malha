import { expect, test } from '@playwright/test';

test('painel e portal usam CSP com nonce por requisição; o site mantém a política estática', async ({ page, request }) => {
  const violations: string[] = [];
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });

  const first = (await request.get('/')).headers()['content-security-policy'];
  const second = (await request.get('/')).headers()['content-security-policy'];
  for (const policy of [first, second]) {
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy.split(';').find((part) => part.trim().startsWith('script-src'))).not.toContain("'unsafe-inline'");
  }
  expect(first).not.toBe(second);
  expect((await request.get('/entrar')).headers()['content-security-policy']).toContain("'strict-dynamic'");
  const site = (await request.get('/site')).headers()['content-security-policy'];
  expect(site).toContain("frame-ancestors 'none'");
  expect(site).not.toContain('nonce-');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral das fazendas' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: /^Painéis/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Painéis da operação' })).toBeVisible();
  const nonced = await page.locator('script[nonce]').count();
  expect(nonced).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
