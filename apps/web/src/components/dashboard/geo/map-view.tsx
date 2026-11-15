'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, CircleCheck, CircleMinus, CircleX, Crosshair, FlaskConical, MapPinOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import type { DashboardFarm } from '../../../server/dashboard';
import type { Geo, TrafficPeriod } from '../../../server/network/types';
import { EmptyState, formatDate, requestJson, wholeNumber } from '../presentation';
import {
  aggregateByArea, buildMapFarms, formatBytes, formatKm, formatMetric, HEALTH, isLocated, METRICS, metricValue, sortFarms,
  type Health, type MapFarm, type MetricKey, type SortKey,
} from './analysis';
import { resolveMapStyle } from './config';
import styles from './map-view.module.css';

const MapCanvas = dynamic(() => import('./map-canvas'), {
  ssr: false,
  loading: () => <p className={styles.stageNote} role="status">Carregando o mapa…</p>,
});

const PERIODS: Array<{ value: TrafficPeriod; label: string; long: string }> = [
  { value: '24h', label: '24 h', long: 'últimas 24 horas' },
  { value: '7d', label: '7 dias', long: 'últimos 7 dias' },
  { value: '30d', label: '30 dias', long: 'últimos 30 dias' },
];

const HEALTH_ICON = { healthy: CircleCheck, missing: CircleMinus, warning: TriangleAlert, critical: CircleX } satisfies Record<Health, unknown>;
const HEALTH_TONE: Record<Health, string> = { healthy: 'healthy', missing: 'neutral', warning: 'warning', critical: 'critical' };

function HealthBadge({ health }: { health: Health }) {
  const Icon = HEALTH_ICON[health];
  return <span className={`status ${HEALTH_TONE[health]}`}><Icon size={14} aria-hidden="true" />{HEALTH[health].label}</span>;
}

const COLUMNS: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'Fazenda' },
  { key: 'health', label: 'Saúde' },
  { key: 'traffic', label: 'Tráfego', numeric: true },
  { key: 'offline', label: 'Ativos offline', numeric: true },
  { key: 'occurrences', label: 'Ocorrências', numeric: true },
  { key: 'collector', label: 'Dados enviados', numeric: true },
  { key: 'nearest', label: 'Mais próxima', numeric: true },
];

type MapStatus = 'loading' | 'ready' | 'basemap-failed' | 'unavailable';

export function MapView({ farms, farmId, online }: { farms: DashboardFarm[]; farmId: string; online: boolean }) {
  const reduced = useReducedMotion() ?? false;
  const [periodIndex, setPeriodIndex] = useState(1);
  const period = PERIODS[periodIndex];
  const [metric, setMetric] = useState<MetricKey>('traffic');
  const [heatmap, setHeatmap] = useState(true);
  // Cada consulta tem uma chave (período + tentativa); carregando = a última resposta não é da chave atual.
  const [response, setResponse] = useState<{ key: string; geo: Geo | null; error: string | null }>({ key: '', geo: null, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');
  const [areaBy, setAreaBy] = useState<'uf' | 'region'>('uf');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'health', direction: 'desc' });
  const [announcement, setAnnouncement] = useState('');
  const [attempt, setAttempt] = useState(0);
  const mapRegion = useRef<HTMLDivElement>(null);
  const basemap = resolveMapStyle();

  const key = `${period.value}:${attempt}`;
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    requestJson<Geo>(`/api/network/geo?period=${period.value}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setResponse({ key, geo: result, error: null }); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setResponse((current) => ({ key, geo: current.geo, error: reason instanceof Error ? reason.message : 'Falha ao carregar o mapa.' }));
      });
    return () => controller.abort();
  }, [key, period.value, online]);
  const { geo, error } = response;
  const loading = online && response.key !== key;

  // A distância até a mais próxima considera todas as fazendas do escopo; o filtro do painel só recorta a lista.
  const all = useMemo(() => buildMapFarms(geo?.farms ?? [], farms), [geo, farms]);
  const visibleIds = useMemo(() => new Set(farms.filter((farm) => farmId === 'all' || farm.id === farmId).map((farm) => farm.id)), [farms, farmId]);
  const visible = useMemo(() => all.filter((farm) => visibleIds.has(farm.farmId)), [all, visibleIds]);
  const located = visible.filter(isLocated);
  const sorted = useMemo(() => sortFarms(visible, sort.key, sort.direction), [visible, sort]);
  const areas = useMemo(() => aggregateByArea(visible, areaBy), [visible, areaBy]);
  const synthetic = visible.some((farm) => farm.synthetic);
  const selected = selectedId && visible.some((farm) => farm.farmId === selectedId) ? selectedId : null;
  const metricMax = Math.max(0, ...visible.map((farm) => metricValue(farm, metric)));

  const onStatus = useCallback((status: Exclude<MapStatus, 'loading'>) => setMapStatus(status), []);
  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);

  function showOnMap(farm: MapFarm) {
    setSelectedId(farm.farmId);
    setFocusToken((value) => value + 1);
    setAnnouncement(`Mapa centralizado em ${farm.name}.`);
    mapRegion.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }

  function toggleSort(key: SortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'name' || key === 'uf' || key === 'nearest' ? 'asc' : 'desc' });
  }

  if (!geo && error) {
    return (
      <section className="panel">
        <p className="message danger" role="alert">{error}</p>
        <div className={styles.retry}><button className="button" type="button" onClick={() => setAttempt((value) => value + 1)} disabled={!online}><RefreshCw size={16} aria-hidden="true" /> Tentar de novo</button></div>
      </section>
    );
  }

  return (
    <div className={styles.layout} data-loading={loading ? '' : undefined}>
      <section className={`panel ${styles.controls}`} aria-label="Opções do mapa">
        <fieldset className={styles.metricField}>
          <legend>Mapa de calor por</legend>
          <div className={styles.segmented}>
            {(Object.keys(METRICS) as MetricKey[]).map((key) => (
              <label key={key} className={styles.segment}>
                <input type="radio" name="map-metric" value={key} checked={metric === key} onChange={() => setMetric(key)} />
                <span>{METRICS[key].label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.periodField}>
          <span>Período: <strong>{period.long}</strong></span>
          <input type="range" min={0} max={PERIODS.length - 1} step={1} value={periodIndex} list="map-periods"
            aria-valuetext={period.long} onChange={(event) => setPeriodIndex(Number(event.target.value))} />
          <span className={styles.ticks} aria-hidden="true">{PERIODS.map((item) => <span key={item.value}>{item.label}</span>)}</span>
          <datalist id="map-periods">{PERIODS.map((item, index) => <option key={item.value} value={index} label={item.label} />)}</datalist>
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={heatmap} onChange={(event) => setHeatmap(event.target.checked)} />
          <span>Mostrar mapa de calor</span>
        </label>
      </section>

      <section className={`panel ${styles.mapPanel}`} aria-labelledby="map-heading">
        <div className="panel-heading">
          <div>
            <h2 id="map-heading">Fazendas no mapa</h2>
            <p>Cor e anel indicam a saúde; o calor mostra {METRICS[metric].label.toLowerCase()} nos {period.long}.</p>
          </div>
          <span className="count-label">{located.length} de {visible.length} posicionadas</span>
        </div>
        <div className={styles.stage} ref={mapRegion}>
          {mapStatus === 'unavailable' ? (
            <div className={styles.fallback} role="status">
              <MapPinOff size={22} aria-hidden="true" />
              <strong>O mapa interativo não está disponível neste navegador</strong>
              <span>Ele precisa de WebGL 2. As mesmas fazendas e indicadores estão nas tabelas abaixo, e o mapa do parque segue na Visão geral.</span>
            </div>
          ) : (
            <MapCanvas farms={visible} metric={metric} heatmap={heatmap} selectedId={selected} focusToken={focusToken} reduced={reduced}
              periodLabel={period.label} onSelect={onSelect} onStatus={onStatus} />
          )}
        </div>
        <div className={styles.legend}>
          <ul aria-label="Legenda de saúde">
            {(['healthy', 'missing', 'warning', 'critical'] as Health[]).map((health) => (
              <li key={health}><i className={styles.dot} data-health={health} aria-hidden="true" />{HEALTH[health].label}</li>
            ))}
          </ul>
          {heatmap && (
            <div className={styles.heatLegend}>
              <span>{METRICS[metric].short}</span>
              <i className={styles.heatScale} aria-hidden="true" />
              <span>0 a {formatMetric(metricMax, metric)}</span>
            </div>
          )}
        </div>
        <div className={styles.notes}>
          {mapStatus === 'basemap-failed' && <p className="message warning" role="status"><TriangleAlert size={16} aria-hidden="true" />O mapa base não carregou. Mostrando as fazendas sobre o contorno local.</p>}
          {basemap.kind === 'none' && <p>Mapa base desligado nesta instalação (<code>NEXT_PUBLIC_MAP_STYLE_URL=none</code>): só o contorno local.</p>}
          {visible.length > located.length && <p>{visible.length - located.length} {visible.length - located.length === 1 ? 'fazenda sem coordenadas não aparece' : 'fazendas sem coordenadas não aparecem'} no mapa: cadastre latitude e longitude em Administração.</p>}
          {synthetic && <p className={styles.synthetic}><FlaskConical size={14} aria-hidden="true" /> Tráfego, portas e capturas marcados como fictícios são dados de demonstração.</p>}
          <p>Com o foco no mapa, use as setas para mover e + ou - para aproximar. Em telas de toque, use dois dedos.</p>
          {geo && <p>Indicadores de {formatDate(geo.from)} a {formatDate(geo.to)} (horário de Cuiabá).</p>}
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
      </section>

      <section className="panel" aria-labelledby="area-heading">
        <div className="panel-heading">
          <div>
            <h2 id="area-heading">Por {areaBy === 'uf' ? 'estado' : 'região'}</h2>
            <p>Soma das fazendas no período; a saúde é a da pior fazenda.</p>
          </div>
          <div className={styles.areaToggle} role="group" aria-label="Agrupar por">
            <button type="button" className="button" aria-pressed={areaBy === 'uf'} onClick={() => setAreaBy('uf')}>UF</button>
            <button type="button" className="button" aria-pressed={areaBy === 'region'} onClick={() => setAreaBy('region')}>Região</button>
          </div>
        </div>
        {areas.length ? (
          <div className={`table-container ${styles.tableWrap}`} tabIndex={0} role="region" aria-label={`Indicadores por ${areaBy === 'uf' ? 'estado' : 'região'}`}>
            <table>
              <caption className="visually-hidden">Indicadores por {areaBy === 'uf' ? 'UF' : 'região'} nos {period.long}</caption>
              <thead><tr><th scope="col">{areaBy === 'uf' ? 'UF' : 'Região'}</th><th scope="col">Fazendas</th><th scope="col">Saúde</th><th scope="col">Tráfego</th><th scope="col">Ativos offline</th><th scope="col">Ocorrências</th><th scope="col">Dados enviados</th></tr></thead>
              <tbody>
                {areas.map((area) => (
                  <tr key={area.key || 'none'}>
                    <th scope="row">{area.label}</th>
                    <td className={styles.number}>{wholeNumber.format(area.farms)}</td>
                    <td><HealthBadge health={area.health} /></td>
                    <td className={styles.number}>{formatBytes(area.trafficBytes)}</td>
                    <td className={styles.number}>{wholeNumber.format(area.offlineAssets)} de {wholeNumber.format(area.assets)}</td>
                    <td className={styles.number}>{wholeNumber.format(area.openOccurrences)}</td>
                    <td className={styles.number}>{formatBytes(area.collectorBytes)} · {wholeNumber.format(area.captures)} capturas</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title={loading ? 'Carregando' : 'Nenhuma fazenda no escopo'}>{loading ? 'Buscando os indicadores do período.' : 'Cadastre fazendas em Administração.'}</EmptyState>}
      </section>

      <section className="panel" aria-labelledby="farm-table-heading">
        <div className="panel-heading">
          <div>
            <h2 id="farm-table-heading">Fazendas</h2>
            <p>As mesmas fazendas e métricas do mapa. Clique no título de uma coluna para ordenar.</p>
          </div>
          <span className="count-label">{visible.length} {visible.length === 1 ? 'fazenda' : 'fazendas'}</span>
        </div>
        {sorted.length ? (
          <div className={`table-container ${styles.tableWrap}`} tabIndex={0} role="region" aria-label="Tabela de fazendas do mapa">
            <table className={styles.farmTable}>
              <caption className="visually-hidden">Fazendas com saúde, tráfego, ativos offline, ocorrências, dados enviados e fazenda mais próxima, nos {period.long}</caption>
              <thead>
                <tr>
                  {COLUMNS.map((column) => {
                    const active = sort.key === column.key;
                    const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <th key={column.key} scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button type="button" className={styles.sortButton} onClick={() => toggleSort(column.key)}>
                          {column.label}<Icon size={14} aria-hidden="true" />
                        </button>
                      </th>
                    );
                  })}
                  <th scope="col"><span className="visually-hidden">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((farm) => (
                  <tr key={farm.farmId} data-selected={farm.farmId === selected ? '' : undefined}>
                    <th scope="row">
                      <span className={styles.farmCell}>
                        <strong>{farm.name}</strong>
                        <small>{farm.location}{farm.synthetic ? ' · fictício' : ''}</small>
                      </span>
                    </th>
                    <td><HealthBadge health={farm.health} /></td>
                    <td className={styles.number}>{formatBytes(farm.trafficBytes)}</td>
                    <td className={styles.number}>{wholeNumber.format(farm.offlineAssets)} de {wholeNumber.format(farm.assets)}</td>
                    <td className={styles.number}>{wholeNumber.format(farm.openOccurrences)}</td>
                    <td className={styles.number}>{farm.collector ? `${formatBytes(farm.collector.payloadBytes)} · ${wholeNumber.format(farm.collector.batches)} lotes` : 'Sem coletor'}</td>
                    <td className={styles.number}>{farm.nearest ? <>{formatKm(farm.nearest.km)} <small>{farm.nearest.name.replace(/^Fazenda /, '')}</small></> : '—'}</td>
                    <td>
                      {isLocated(farm) && mapStatus !== 'unavailable'
                        ? <button type="button" className="button" onClick={() => showOnMap(farm)} aria-label={`Ver ${farm.name} no mapa`}><Crosshair size={16} aria-hidden="true" /> Ver no mapa</button>
                        : <span className={styles.muted}>{isLocated(farm) ? '' : 'Sem coordenadas'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title={loading ? 'Carregando' : 'Nenhuma fazenda no escopo'}>{loading ? 'Buscando os indicadores do período.' : 'Nenhuma fazenda corresponde ao filtro.'}</EmptyState>}
        {error && <p className="message warning" role="status"><TriangleAlert size={16} aria-hidden="true" />{error} Exibindo o período anterior.</p>}
      </section>
    </div>
  );
}
