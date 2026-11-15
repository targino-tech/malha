'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent, Popup, StyleSpecification } from 'maplibre-gl';
import { MT_OUTLINE, NEIGHBOR_OUTLINES } from '../../../app/site/_components/mt-outline';
import { formatDate } from '../presentation';
import { boundsOf, formatBytes, formatKm, HEALTH, isLocated, METRICS, toFeatureCollection, type MapFarm, type MetricKey } from './analysis';
import { OSM_ATTRIBUTION, resolveMapStyle } from './config';
import styles from './map-view.module.css';

export type MapCanvasProps = {
  farms: MapFarm[];
  metric: MetricKey;
  heatmap: boolean;
  selectedId: string | null;
  /** Muda a cada pedido explícito de centralizar (botão da tabela), mesmo para a mesma fazenda. */
  focusToken: number;
  reduced: boolean;
  periodLabel: string;
  onSelect: (farmId: string | null) => void;
  onStatus: (status: 'ready' | 'basemap-failed' | 'unavailable') => void;
};

const LOCALE = {
  'AttributionControl.ToggleAttribution': 'Mostrar ou ocultar créditos do mapa',
  'Map.Title': 'Mapa das fazendas',
  'NavigationControl.ZoomIn': 'Aproximar',
  'NavigationControl.ZoomOut': 'Afastar',
  'NavigationControl.ResetBearing': 'Voltar o norte para cima',
  'Popup.Close': 'Fechar detalhes da fazenda',
  'CooperativeGesturesHandler.WindowsHelpText': 'Use Ctrl + rolagem para aproximar o mapa',
  'CooperativeGesturesHandler.MacHelpText': 'Use ⌘ + rolagem para aproximar o mapa',
  'CooperativeGesturesHandler.MobileHelpText': 'Use dois dedos para mover o mapa',
};

const SEVERITY_COLOR = ['match', ['get', 'severity'], 3, HEALTH.critical.color, 2, HEALTH.warning.color, 1, HEALTH.missing.color, HEALTH.healthy.color] as const;

function outlineFeature(outline: readonly number[]) {
  const coordinates: Array<[number, number]> = [];
  for (let i = 0; i < outline.length; i += 2) coordinates.push([outline[i], outline[i + 1]]);
  coordinates.push(coordinates[0]);
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } };
}

/** Fundo local, sem nenhuma requisição externa: contorno de MT e vizinhos, o mesmo do mapa ASCII. */
function localStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      outlines: { type: 'geojson', data: { type: 'FeatureCollection', features: [outlineFeature(MT_OUTLINE), ...NEIGHBOR_OUTLINES.map(outlineFeature)] } },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0a110c' } },
      { id: 'outlines', type: 'line', source: 'outlines', paint: { 'line-color': '#2a4430', 'line-width': 1.2 } },
    ],
  };
}

function hasWebGl2() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

function row(list: HTMLElement, label: string, value: string) {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  list.append(term, detail);
}

/** Popup montado com textContent: nenhum dado da API vira HTML. */
function popupContent(farm: MapFarm, periodLabel: string) {
  const root = document.createElement('div');
  root.className = styles.popup;
  const title = document.createElement('strong');
  title.textContent = farm.name;
  const place = document.createElement('span');
  place.textContent = farm.location;
  const health = document.createElement('span');
  health.className = styles.popupHealth;
  health.dataset.health = farm.health;
  health.textContent = HEALTH[farm.health].label;
  const list = document.createElement('dl');
  row(list, `${METRICS.traffic.short} (${periodLabel})`, formatBytes(farm.trafficBytes));
  row(list, 'Ativos offline', `${farm.offlineAssets} de ${farm.assets}`);
  row(list, 'Ocorrências abertas', String(farm.openOccurrences));
  row(list, 'Dados enviados', farm.collector ? `${formatBytes(farm.collector.payloadBytes)} em ${farm.collector.batches} lotes` : 'Sem coletor ativo');
  if (farm.collector) row(list, 'Última captura', formatDate(farm.collector.lastCaptureAt));
  if (farm.nearest) row(list, 'Mais próxima', `${farm.nearest.name.replace(/^Fazenda /, '')} · ${formatKm(farm.nearest.km)}`);
  root.append(title, place, health, list);
  if (farm.synthetic) {
    const note = document.createElement('small');
    note.textContent = 'Dados fictícios de demonstração';
    root.append(note);
  }
  return root;
}

export default function MapCanvas(props: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const popupModule = useRef<typeof import('maplibre-gl') | null>(null);
  const latest = useRef(props);
  const [loaded, setLoaded] = useState(0);

  useEffect(() => { latest.current = props; });

  // Cria o mapa uma vez. O MapLibre é carregado sob demanda, só no navegador.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!hasWebGl2()) {
      latest.current.onStatus('unavailable');
      return;
    }
    let disposed = false;
    let map: MapLibreMap | null = null;
    void (async () => {
      const maplibre = await import('maplibre-gl');
      if (disposed) return;
      popupModule.current = maplibre;
      // Worker servido pelo próprio Malha (mesma origem): a CSP só precisa de worker-src 'self'.
      maplibre.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);
      const config = resolveMapStyle();
      const reduced = latest.current.reduced;
      let fellBack = config.kind === 'none';
      try {
        map = new maplibre.Map({
          container,
          style: config.kind === 'none' ? localStyle() : config.url,
          bounds: [-61.6, -18.1, -50.2, -7.3],
          fitBoundsOptions: { padding: 32 },
          attributionControl: { compact: true, ...(config.kind === 'none' ? {} : { customAttribution: OSM_ATTRIBUTION }) },
          cooperativeGestures: true,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          maxPitch: 0,
          renderWorldCopies: false,
          fadeDuration: reduced ? 0 : 200,
          locale: LOCALE,
        });
      } catch {
        latest.current.onStatus('unavailable');
        return;
      }
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
      map.getCanvas().setAttribute('aria-label', 'Mapa das fazendas. Com o foco aqui, use as setas para mover e as teclas + e - para aproximar. A tabela abaixo traz as mesmas fazendas.');

      const fallback = () => {
        if (fellBack || !map) return;
        fellBack = true;
        map.setStyle(localStyle());
      };
      // Estilo externo que não carrega (rede, CSP, servidor fora): troca pelo fundo local e mantém as fazendas.
      // Depois que o estilo carrega, falha de um tile isolado não derruba o mapa base; só recusa de acesso.
      let styleReady = false;
      const timer = window.setTimeout(() => { if (!styleReady) fallback(); }, 12_000);
      map.on('error', (event) => {
        if (!map) return;
        const status = (event.error as { status?: number } | undefined)?.status;
        if (!styleReady || status === 403 || status === 401) fallback();
      });
      map.on('style.load', () => {
        styleReady = true;
        window.clearTimeout(timer);
        latest.current.onStatus(fellBack && config.kind !== 'none' ? 'basemap-failed' : 'ready');
        setLoaded((value) => value + 1);
      });
      map.on('click', 'clusters', (event: MapMouseEvent & { features?: Array<{ properties: Record<string, unknown>; geometry: unknown }> }) => {
        const feature = event.features?.[0];
        const source = map?.getSource<GeoJSONSource>('farms');
        if (!feature || !source || !map) return;
        void source.getClusterExpansionZoom(Number(feature.properties.cluster_id)).then((zoom) => {
          const [lon, lat] = (feature.geometry as { coordinates: [number, number] }).coordinates;
          map?.easeTo({ center: [lon, lat], zoom, duration: latest.current.reduced ? 0 : 300 });
        });
      });
      map.on('click', 'farm-points', (event: MapMouseEvent & { features?: Array<{ properties: Record<string, unknown> }> }) => {
        const id = event.features?.[0]?.properties.farmId;
        if (typeof id === 'string') latest.current.onSelect(id);
      });
      // Clique fora das fazendas fecha os detalhes (o fechamento do popup avisa a seleção).
      map.on('click', (event) => {
        if (!map?.getLayer('farm-points')) return;
        if (!map.queryRenderedFeatures(event.point, { layers: ['farm-points', 'clusters'] }).length) popupRef.current?.remove();
      });
      for (const layer of ['clusters', 'farm-points']) {
        map.on('mouseenter', layer, () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { if (map) map.getCanvas().style.cursor = ''; });
      }
    })();
    return () => {
      disposed = true;
      popupRef.current?.remove();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Camadas das fazendas: recriadas a cada estilo carregado (inclusive depois do fundo local).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const { farms, metric } = latest.current;
    const data = toFeatureCollection(farms, metric);
    if (!map.getSource('farms')) {
      map.addSource('farms', {
        type: 'geojson', data, cluster: true, clusterRadius: 44, clusterMaxZoom: 8,
        clusterProperties: { severity: ['max', ['get', 'severity']] },
      });
      map.addSource('farms-heat', { type: 'geojson', data });
      map.addLayer({
        id: 'heat', type: 'heatmap', source: 'farms-heat', maxzoom: 12,
        paint: {
          'heatmap-weight': ['get', 'heat'],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 1, 9, 2.2],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 30, 6, 48, 10, 80],
          'heatmap-opacity': 0.78,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(4,7,5,0)', 0.15, 'rgba(182,243,122,0.22)', 0.4, 'rgba(217,184,102,0.5)', 0.7, 'rgba(241,180,91,0.72)', 1, 'rgba(255,143,133,0.88)'],
        },
      });
      map.addLayer({
        id: 'clusters', type: 'circle', source: 'farms', filter: ['has', 'point_count'],
        paint: {
          'circle-color': SEVERITY_COLOR as never,
          'circle-radius': ['step', ['get', 'point_count'], 15, 5, 19, 20, 24],
          'circle-stroke-color': '#040705', 'circle-stroke-width': 2, 'circle-opacity': 0.92,
        },
      });
      // Contagem do agrupamento só quando o estilo tem glifos; reaproveita a fonte que o próprio estilo usa.
      const glyphs = map.getStyle().glyphs;
      const font = map.getStyle().layers.map((layer) => (layer.layout as { 'text-font'?: unknown } | undefined)?.['text-font'])
        .find((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'));
      if (glyphs && font) {
        map.addLayer({
          id: 'cluster-count', type: 'symbol', source: 'farms', filter: ['has', 'point_count'],
          layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': font, 'text-size': 12, 'text-allow-overlap': true },
          paint: { 'text-color': '#071006' },
        });
      }
      // Segunda codificação além da cor: anel em volta das fazendas em atenção ou críticas.
      map.addLayer({
        id: 'farm-ring', type: 'circle', source: 'farms', filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'severity'], 2]],
        paint: { 'circle-radius': ['match', ['get', 'severity'], 3, 14, 11], 'circle-opacity': 0, 'circle-stroke-color': SEVERITY_COLOR as never,
          'circle-stroke-width': ['match', ['get', 'severity'], 3, 2.5, 1.5] },
      });
      map.addLayer({
        id: 'farm-points', type: 'circle', source: 'farms', filter: ['!', ['has', 'point_count']],
        paint: { 'circle-color': SEVERITY_COLOR as never, 'circle-radius': 7, 'circle-stroke-color': '#040705', 'circle-stroke-width': 2 },
      });
      map.addLayer({
        id: 'farm-selected', type: 'circle', source: 'farms', filter: ['==', ['get', 'farmId'], ''],
        paint: { 'circle-radius': 18, 'circle-opacity': 0, 'circle-stroke-color': '#ecf4e8', 'circle-stroke-width': 2 },
      });
      const box = boundsOf(farms);
      if (box) map.fitBounds(box, { padding: 56, maxZoom: 9, duration: 0 });
    }
  }, [loaded]);

  // Dados e métrica: só troca o GeoJSON e a visibilidade do calor, sem recriar o mapa.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !map.getSource('farms')) return;
    const data = toFeatureCollection(props.farms, props.metric);
    map.getSource<GeoJSONSource>('farms')?.setData(data);
    map.getSource<GeoJSONSource>('farms-heat')?.setData(data);
    map.setLayoutProperty('heat', 'visibility', props.heatmap ? 'visible' : 'none');
  }, [loaded, props.farms, props.metric, props.heatmap]);

  // Fazenda selecionada: destaque, popup e, quando pedido pela tabela, centraliza sem animação de voo.
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = popupModule.current;
    if (!map || !maplibre || !loaded || !map.getLayer('farm-selected')) return;
    // Solta a referência antes de remover: o evento close só limpa a seleção quando quem fecha é a pessoa.
    const previous = popupRef.current;
    popupRef.current = null;
    previous?.remove();
    const farm = props.farms.find((item) => item.farmId === props.selectedId);
    map.setFilter('farm-selected', ['==', ['get', 'farmId'], farm && isLocated(farm) ? farm.farmId : '']);
    if (!farm || !isLocated(farm)) return;
    const popup = new maplibre.Popup({ closeButton: true, closeOnClick: false, maxWidth: '18rem', offset: 14, focusAfterOpen: false })
      .setLngLat([farm.longitude, farm.latitude])
      .setDOMContent(popupContent(farm, props.periodLabel))
      .addTo(map);
    popup.on('close', () => {
      if (popupRef.current === popup) {
        popupRef.current = null;
        latest.current.onSelect(null);
      }
    });
    popupRef.current = popup;
  }, [loaded, props.selectedId, props.farms, props.periodLabel]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !props.focusToken) return;
    const farm = latest.current.farms.find((item) => item.farmId === latest.current.selectedId);
    if (!farm || !isLocated(farm)) return;
    map.easeTo({ center: [farm.longitude, farm.latitude], zoom: Math.max(map.getZoom(), 7), duration: latest.current.reduced ? 0 : 300 });
  }, [loaded, props.focusToken]);

  return <div ref={containerRef} className={styles.canvas} />;
}
