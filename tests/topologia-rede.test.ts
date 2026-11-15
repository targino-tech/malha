import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildGraph, deviceCarriesVlan, formatBps, isPortToPort, isStale, latestObservation, navigate, normalizeEdges, readingOrder,
} from '../apps/web/src/components/dashboard/topology-graph';
import { database, DEMO_ORG } from '../apps/web/src/server/db';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';
import { devicePorts, topology, traffic } from '../apps/web/src/server/network/queries';
import type { DevicePort, Topology, TopologyEdge, TopologyNode } from '../apps/web/src/server/network/types';

process.env.MALHA_MODE = 'demo';
process.env.MALHA_DEMO_DB = 'memory://';

const VALE_VERDE = '00000000-0000-4000-8000-000000000102';
const CERRADO = '00000000-0000-4000-8000-000000000104';
const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
const admin: Principal = { orgId: DEMO_ORG, actor: 'teste', role: 'admin', farmIds: null, demo: false };
const NOW = '2026-11-15T12:00:00.000Z';

function node(assetId: string, role: TopologyNode['role'], extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    assetId, name: assetId, role, vendor: null, model: null, ip: null, mac: null, status: 'online', critical: false,
    lastObservedAt: NOW, ports: null, uplink: null, ...extra,
  };
}

function edge(from: string, to: string, extra: Partial<TopologyEdge> = {}): TopologyEdge {
  return {
    from, to, level: 'device', evidence: 'unifi_uplink', fromPortIdx: null, toPortIdx: null,
    firstSeenAt: NOW, lastSeenAt: NOW, synthetic: false, ...extra,
  };
}

function port(idx: number, native: number | null, tagged: number[] = []): DevicePort {
  return {
    idx, name: null, state: 'UP', connector: null, speedMbps: 1000, maxSpeedMbps: 1000, poe: null,
    nativeVlan: native === null ? null : { vlanId: native, name: null }, taggedVlans: tagged.map((vlanId) => ({ vlanId, name: null })),
    rxBps: null, txBps: null, counters: null, observedAt: NOW, synthetic: false,
  };
}

describe('regras de evidência das ligações', () => {
  test('porta a porta só com nível port e as duas portas; o resto é ligação entre dispositivos', () => {
    assert.equal(isPortToPort({ level: 'port', fromPortIdx: 1, toPortIdx: 24 }), true);
    assert.equal(isPortToPort({ level: 'port', fromPortIdx: 1, toPortIdx: null }), false);
    assert.equal(isPortToPort({ level: 'port', fromPortIdx: null, toPortIdx: 3 }), false);
    // Portas preenchidas em ligação de nível dispositivo não promovem a ligação.
    assert.equal(isPortToPort({ level: 'device', fromPortIdx: 1, toPortIdx: 2 }), false);
    const [normalized] = normalizeEdges({ nodes: [node('a', 'switch'), node('b', 'gateway')], edges: [edge('a', 'b', { level: 'port', fromPortIdx: 1 })] });
    assert.equal(normalized!.portToPort, false);
    assert.equal(normalized!.fromPortIdx, null, 'porta solta não aparece no desenho');
    assert.equal(normalized!.toPortIdx, null);
  });

  test('nenhuma ligação é inventada: pontas fora da lista, laços e pares repetidos ficam de fora', () => {
    const nodes = [node('gw', 'gateway'), node('sw', 'switch'), node('ap', 'ap')];
    const edges = normalizeEdges({ nodes, edges: [
      edge('sw', 'gw'), edge('sw', 'gw', { level: 'port', fromPortIdx: 25, toPortIdx: 2, evidence: 'lldp' }), edge('gw', 'sw'),
      edge('ap', 'ap'), edge('ap', 'fora-do-escopo'),
    ] });
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.portToPort, true, 'fica a evidência mais forte do par');
    assert.equal(edges[0]!.evidence, 'lldp');
    const graph = buildGraph({ nodes, edges: [edge('sw', 'gw'), edge('ap', 'fora-do-escopo')] });
    assert.equal(graph.edges.length, 1);
    assert.deepEqual(graph.unlinked, ['ap'], 'AP sem evidência não é pendurado no gateway');
    assert.equal(graph.byId.get('ap')!.parent, null);
    assert.equal(graph.byId.get('ap')!.group, 'unlinked');
  });
});

describe('hierarquia e desenho', () => {
  test('gateway no topo, switches e APs abaixo, pai centralizado sobre os filhos', () => {
    const nodes = [node('ap2', 'ap'), node('sw', 'switch'), node('gw', 'gateway'), node('ap1', 'ap'), node('sw2', 'switch')];
    const graph = buildGraph({ nodes, edges: [edge('sw', 'gw', { level: 'port', fromPortIdx: 25, toPortIdx: 2 }), edge('ap1', 'sw'), edge('ap2', 'sw'), edge('sw2', 'gw')] });
    assert.deepEqual(graph.roots, ['gw']);
    assert.equal(graph.byId.get('gw')!.depth, 0);
    assert.equal(graph.byId.get('sw')!.depth, 1);
    assert.equal(graph.byId.get('ap1')!.depth, 2);
    const sw = graph.byId.get('sw')!;
    assert.equal(sw.x, (graph.byId.get('ap1')!.x + graph.byId.get('ap2')!.x) / 2);
    assert.ok(graph.byId.get('ap1')!.y > sw.y && sw.y > graph.byId.get('gw')!.y);
    assert.ok(graph.bounds.width > 0 && graph.bounds.height > 0);
    assert.deepEqual(readingOrder(graph), ['gw', 'sw', 'ap1', 'ap2', 'sw2']);
    // Mesma entrada, mesmo desenho.
    assert.deepEqual(buildGraph({ nodes: [...nodes].reverse(), edges: [edge('sw', 'gw'), edge('ap1', 'sw'), edge('ap2', 'sw'), edge('sw2', 'gw')] }).nodes.map((item) => [item.assetId, item.x, item.y]).sort(),
      graph.nodes.map((item) => [item.assetId, item.x, item.y]).sort());
  });

  test('ciclo não trava o desenho e a ligação que fecharia o ciclo continua desenhada como adicional', () => {
    const nodes = [node('a', 'switch'), node('b', 'switch'), node('c', 'switch')];
    const graph = buildGraph({ nodes, edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')] });
    assert.equal(graph.roots.length, 1);
    assert.equal(graph.edges.length, 3);
    assert.equal(graph.edges.filter((item) => item.primary).length, 2);
    assert.equal(new Set(graph.nodes.map((item) => `${item.x},${item.y}`)).size, 3, 'nós não se sobrepõem');
  });

  test('nó com dois uplinks usa o porta a porta para a hierarquia e mantém o outro', () => {
    const nodes = [node('gw', 'gateway'), node('sw1', 'switch'), node('sw2', 'switch'), node('ap', 'ap')];
    const graph = buildGraph({ nodes, edges: [edge('sw1', 'gw'), edge('sw2', 'gw'), edge('ap', 'sw1'), edge('ap', 'sw2', { level: 'port', fromPortIdx: 1, toPortIdx: 8 })] });
    assert.equal(graph.byId.get('ap')!.parent, 'sw2');
    assert.equal(graph.edges.find((item) => item.from === 'ap' && item.to === 'sw1')!.primary, false);
  });

  test('teclado percorre montante, jusante, irmãos e extremos', () => {
    const nodes = [node('gw', 'gateway'), node('sw', 'switch'), node('ap1', 'ap'), node('ap2', 'ap'), node('solto', 'other')];
    const graph = buildGraph({ nodes, edges: [edge('sw', 'gw'), edge('ap1', 'sw'), edge('ap2', 'sw')] });
    assert.equal(navigate(graph, 'gw', 'ArrowDown'), 'sw');
    assert.equal(navigate(graph, 'sw', 'ArrowDown'), 'ap1');
    assert.equal(navigate(graph, 'ap1', 'ArrowRight'), 'ap2');
    assert.equal(navigate(graph, 'ap2', 'ArrowLeft'), 'ap1');
    assert.equal(navigate(graph, 'ap2', 'ArrowUp'), 'sw');
    assert.equal(navigate(graph, 'gw', 'ArrowUp'), null);
    assert.equal(navigate(graph, 'ap2', 'ArrowRight'), 'solto', 'segue a ordem de leitura até os nós sem ligação');
    assert.equal(navigate(graph, 'ap1', 'Home'), 'gw');
    assert.equal(navigate(graph, 'gw', 'End'), 'solto');
    assert.equal(navigate(graph, 'gw', 'x'), null);
  });

  test('grafo grande no limite da API é montado sem estourar a pilha', () => {
    const nodes = Array.from({ length: 2000 }, (_, index) => node(`n${String(index).padStart(4, '0')}`, index ? 'switch' : 'gateway'));
    const edges = nodes.slice(1).map((item, index) => edge(item.assetId, nodes[index]!.assetId));
    const graph = buildGraph({ nodes, edges });
    assert.equal(graph.roots.length, 1);
    assert.equal(Math.max(...graph.nodes.map((item) => item.depth)), 1999);
  });
});

describe('filtro de VLAN, frescor e formatos', () => {
  test('VLAN nativa ou marcada; sem VLAN por porta informada o resultado é desconhecido, não falso', () => {
    assert.equal(deviceCarriesVlan([port(1, 20), port(2, null, [30])], 30), true);
    assert.equal(deviceCarriesVlan([port(1, 20)], 20), true);
    assert.equal(deviceCarriesVlan([port(1, 10), port(2, null, [20])], 40), false);
    assert.equal(deviceCarriesVlan([port(1, null), port(2, null)], 20), null);
    assert.equal(deviceCarriesVlan(null, 20), null);
  });

  test('desenho desatualizado acima de 15 minutos da observação mais recente', () => {
    const latest = latestObservation([{ lastObservedAt: '2026-11-15T11:40:00.000Z' }, { lastObservedAt: null }, { lastObservedAt: '2026-11-15T11:50:00.000Z' }]);
    assert.equal(latest, '2026-11-15T11:50:00.000Z');
    assert.equal(isStale(latest, NOW), false);
    assert.equal(isStale('2026-11-15T11:44:00.000Z', NOW), true);
    assert.equal(isStale(latestObservation([{ lastObservedAt: null }]), NOW), false, 'sem observação não é "desatualizado"');
  });

  test('taxa em pt-BR e nulo como não lido', () => {
    assert.equal(formatBps(null), '—');
    assert.equal(formatBps(950), '950 bit/s');
    assert.equal(formatBps(12_500_000), '12,5 Mbit/s');
    assert.equal(formatBps(10_000_000_000), '10 Gbit/s');
  });
});

describe('topologia do demo pela API de rede', () => {
  test('grafo do demo só tem ligações da API e porta a porta só onde a API identifica as duas portas', async () => {
    const db = await database();
    for (const farmId of [VALE_VERDE, CERRADO]) {
      const data: Topology = await topology(db, admin, new URLSearchParams({ farmId }));
      const graph = buildGraph(data);
      assert.equal(graph.nodes.length, data.nodes.length);
      const apiPairs = new Set(data.edges.map((item) => `${item.from}>${item.to}`));
      for (const drawn of graph.edges) {
        assert.ok(apiPairs.has(drawn.id), `ligação ${drawn.id} veio da API`);
        const source = data.edges.find((item) => `${item.from}>${item.to}` === drawn.id)!;
        assert.equal(drawn.portToPort, source.level === 'port' && source.fromPortIdx !== null && source.toPortIdx !== null);
      }
      const roots = graph.roots.map((id) => graph.byId.get(id)!.role);
      assert.deepEqual(roots, ['gateway']);
      assert.ok(graph.nodes.filter((item) => item.role === 'ap').every((item) => item.depth >= 1));
    }
    const cerrado = buildGraph(await topology(db, admin, new URLSearchParams({ farmId: CERRADO })));
    assert.ok(cerrado.edges.some((item) => item.portToPort) && cerrado.edges.some((item) => !item.portToPort), 'demo exercita os dois níveis');
    const switchNode = cerrado.nodes.find((item) => item.role === 'switch')!;
    const ports = await devicePorts(db, admin, switchNode.assetId);
    assert.equal(deviceCarriesVlan(ports.ports, 20), true);
    assert.equal(deviceCarriesVlan(ports.ports, 77), false);
    // Série por porta usada no detalhe: a porta de uplink do switch tem tendência no demo.
    const uplinkPort = cerrado.edges.find((item) => item.from === switchNode.assetId && item.portToPort)!.fromPortIdx!;
    const series = await traffic(db, admin, new URLSearchParams({ farmId: CERRADO, assetId: switchNode.assetId, portIdx: String(uplinkPort), period: '24h' }));
    assert.ok(series.points.length > 50);
    assert.deepEqual(series.sources, ['synthetic']);
  });

  test('chamadas do painel de detalhe não atravessam fazenda nem grupo', async () => {
    const db = await database();
    const switchId = (await topology(db, admin, new URLSearchParams({ farmId: CERRADO }))).nodes.find((item) => item.role === 'switch')!.assetId;
    const technician: Principal = { ...admin, role: 'tecnico', farmIds: [VALE_VERDE] };
    const outsider: Principal = { orgId: '00000000-0000-4000-8000-00000000f00d', actor: 'fora', role: 'admin', farmIds: null, demo: false };
    for (const user of [technician, outsider]) {
      await assert.rejects(devicePorts(db, user, switchId), status(404));
      await assert.rejects(traffic(db, user, new URLSearchParams({ farmId: CERRADO, assetId: switchId, portIdx: '25', period: '24h' })), status(404));
    }
    // Fazenda permitida com ativo e porta de outra fazenda: também inexistente.
    await assert.rejects(traffic(db, technician, new URLSearchParams({ farmId: VALE_VERDE, assetId: switchId, portIdx: '25', period: '24h' })), status(404));
  });
});
