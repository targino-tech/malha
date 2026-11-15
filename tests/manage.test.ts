import assert from 'node:assert/strict';
import { test } from 'node:test';
import { email } from '../packages/db/email';

test('email aceita endereços com "s" e normaliza caixa e espaços nas bordas', () => {
  assert.equal(email('joao.silva@empresa.com.br'), 'joao.silva@empresa.com.br');
  assert.equal(email('  Suporte@Fazendas.com  '), 'suporte@fazendas.com');
});

test('email rejeita espaços internos, domínio sem ponto e valores ausentes', () => {
  for (const value of ['joao silva@empresa.com', 'joao@empresa .com', 'joao@empresacom', 'joao@', '', undefined]) {
    assert.throws(() => email(value), /Forneça um e-mail válido\./, String(value));
  }
});
