import { expect, test } from '@playwright/test';

test('API de rede responde no demo com dados fictícios e esconde fazenda inexistente', async ({ request }) => {
  const geo = await request.get('/api/network/geo?period=7d');
  expect(geo.ok(), await geo.text()).toBe(true);
  const { farms } = await geo.json() as { farms: Array<{ farmId: string; location: string; latitude: number | null; synthetic: boolean }> };
  const farm = farms.find((item) => item.location === 'Rio Verde · GO');
  expect(farm?.synthetic).toBe(true);
  expect(farm?.latitude).not.toBeNull();

  const topology = await (await request.get(`/api/network/topology?farmId=${farm!.farmId}`)).json() as {
    nodes: Array<{ assetId: string; role: string }>; edges: Array<{ level: string; synthetic: boolean }>;
  };
  expect(topology.nodes.length).toBeGreaterThan(0);
  expect(topology.edges.every((edge) => edge.synthetic)).toBe(true);
  const switchId = topology.nodes.find((node) => node.role === 'switch')!.assetId;
  const ports = await request.get(`/api/network/devices/${switchId}/ports`);
  expect(ports.ok()).toBe(true);
  const traffic = await (await request.get(`/api/network/traffic?farmId=${farm!.farmId}&period=7d`)).json() as { points: unknown[] };
  expect(traffic.points.length).toBeGreaterThan(100);
  expect((await request.get('/api/network/vlans?limit=5')).ok()).toBe(true);

  expect((await request.get('/api/network/topology?farmId=00000000-0000-4000-8000-000000000999')).status()).toBe(404);
  expect((await request.get(`/api/network/traffic?farmId=${farm!.farmId}&period=1y`)).status()).toBe(400);
});
