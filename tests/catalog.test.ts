import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../apps/web/src/server/catalog';

test('catálogo classifica família e fabricante pelo cadastro', () => {
  assert.deepEqual(classify({ category: 'Switch', name: 'Switch do armazém', model: 'Cisco Catalyst 9200' }), { family: 'core', vendor: 'cisco' });
  assert.deepEqual(classify({ category: 'Ponto de acesso', name: 'AP da portaria', model: 'U6-Pro' }), { family: 'wifi', vendor: null });
  assert.deepEqual(classify({ category: 'AP', name: 'UAP oficina' }), { family: 'wifi', vendor: 'ubiquiti' });
  assert.deepEqual(classify({ category: 'Rádio', name: 'Enlace sede-silo', model: 'LiteBeam 5AC' }), { family: 'radio', vendor: 'ubiquiti' });
  assert.deepEqual(classify({ category: 'Servidor', name: 'DC01', model: 'Windows Server 2022' }), { family: 'servers', vendor: 'windows' });
  assert.deepEqual(classify({ category: 'Controlador de domínio', name: 'DC01' }), { family: 'identity', vendor: null });
  assert.deepEqual(classify({ category: 'Switch', model: 'Huawei S5735' }), { family: 'core', vendor: 'huawei' });
  assert.deepEqual(classify({ category: 'Balança', name: 'Balança de entradas' }), { family: 'field', vendor: null });
  assert.deepEqual(classify({ category: 'Câmera', name: 'Portaria' }), { family: 'security', vendor: null });
  assert.deepEqual(classify({ category: 'Estação de trabalho', name: 'PC do escritório' }), { family: 'endpoints', vendor: null });
  // A categoria vence o nome: um "rádio" chamado "AP" continua sendo enlace de rádio.
  assert.equal(classify({ category: 'Rádio', name: 'AP antigo' }).family, 'radio');
  assert.equal(classify({ category: 'Impressora térmica' }).family, 'endpoints');
  assert.equal(classify({ category: 'Nobreak' }).family, 'other');
});
