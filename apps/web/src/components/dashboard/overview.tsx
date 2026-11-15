'use client';

import { useEffect, useState } from 'react';
import {
  ArrowRight, BellRing, Boxes, Cctv, CircleAlert, CircleCheck, CircleHelp, CircleX, FileText, KeyRound, MapPin, MapPinned,
  Monitor, Network, RadioTower, Server, Tractor, Wifi,
} from 'lucide-react';
import type { AssetState, Charts } from '../../server/charts';
import type { FamilyId } from '../../server/catalog';
import { VENDORS } from '../../server/catalog';
import type { DashboardFarm } from '../../server/dashboard';
import type { DashboardOccurrence } from '../../server/occurrences';
import { FarmMap } from './farm-map';
import { collectorStatus, EmptyState, formatDate, hasFreshCapture, requestJson, StatusBadge, wholeNumber } from './presentation';

type OverviewProps = {
  farms: DashboardFarm[];
  farmId: string;
  generatedAt: string;
  openOccurrences: DashboardOccurrence[];
  onOpenOccurrences: () => void;
  onOpenFarm: (id: string) => void;
  onOpenInventory: () => void;
};

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const STATES: Array<{ key: AssetState; label: string; icon: typeof CircleCheck }> = [
  { key: 'online', label: 'Em contato', icon: CircleCheck },
  { key: 'offline', label: 'Offline', icon: CircleX },
  { key: 'unknown', label: 'Indeterminado', icon: CircleHelp },
  { key: 'manual', label: 'Sem telemetria', icon: FileText },
];
const FAMILY_ICONS: Record<FamilyId, typeof Network> = {
  core: Network, wifi: Wifi, radio: RadioTower, identity: KeyRound, servers: Server, endpoints: Monitor, field: Tractor, security: Cctv, other: Boxes,
};
const vendorLabel = (id: string) => VENDORS.find((vendor) => vendor.id === id)?.label ?? id;

function HealthBar({ totals }: { totals: Record<AssetState, number> }) {
  const sum = STATES.reduce((value, state) => value + totals[state.key], 0);
  return (
    <div className="park-health">
      <div className="park-health-bar" role="img" aria-label={`Saúde do parque: ${STATES.map((state) => `${totals[state.key]} ${state.label.toLowerCase()}`).join(', ')}`}>
        {sum === 0 ? <span className="viz-seg state-manual" style={{ flexGrow: 1 }} /> : STATES.filter((state) => totals[state.key]).map((state) => (
          <span key={state.key} className={`viz-seg state-${state.key}`} style={{ flexGrow: totals[state.key] }} />
        ))}
      </div>
      <ul className="park-health-legend">
        {STATES.map(({ key, label, icon: Icon }) => (
          <li key={key}><i className={`viz-swatch state-${key}`} aria-hidden="true" /><Icon size={14} aria-hidden="true" /> <strong>{wholeNumber.format(totals[key])}</strong> {label}</li>
        ))}
      </ul>
    </div>
  );
}

export function Overview({ farms, farmId, generatedAt, openOccurrences, onOpenOccurrences, onOpenFarm, onOpenInventory }: OverviewProps) {
  const [charts, setCharts] = useState<Charts | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ days: '30' });
    if (farmId !== 'all') params.set('farmId', farmId);
    requestJson<Charts>(`/api/charts?${params}`, { signal: controller.signal }).then(setCharts).catch(() => undefined);
    return () => controller.abort();
  }, [farmId, generatedAt]);

  const unacknowledged = openOccurrences.filter((occurrence) => !occurrence.acknowledgedAt);
  const criticalOpen = unacknowledged.filter((occurrence) => occurrence.severity === 'critical').length;
  const online = farms.filter((farm) => farm.collectorStatus === 'online').length;
  const withCollector = farms.filter((farm) => farm.collectorStatus !== 'missing').length;
  const offlineCritical = farms.reduce((sum, farm) => sum + farm.offlineCriticalCount, 0);
  const assetCount = farms.reduce((sum, farm) => sum + farm.assetCount, 0);
  const unifiCount = farms.reduce((sum, farm) => sum + farm.unifiCount, 0);
  const totals = (charts?.families ?? []).reduce((sum, family) => {
    for (const state of STATES) sum[state.key] += family[state.key];
    return sum;
  }, { online: 0, offline: 0, unknown: 0, manual: 0 } as Record<AssetState, number>);
  const families = (charts?.families ?? []).filter((family) => STATES.some((state) => family[state.key] > 0));
  const orderedFarms = [...farms].sort((a, b) => {
    const priorities = { offline: 0, online: 1, missing: 2 };
    return priorities[a.collectorStatus] - priorities[b.collectorStatus] || a.name.localeCompare(b.name, 'pt-BR');
  });
  const feed = [...openOccurrences].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)).slice(0, 5);
  const farmName = new Map(farms.map((farm) => [farm.id, farm.name]));

  return (
    <div className="content-stack">
      <section className="panel park-hero" aria-labelledby="park-title">
        <div className="park-hero-main">
          <h2 id="park-title">Parque tecnológico</h2>
          <p className="park-figure"><strong>{wholeNumber.format(assetCount)}</strong> <span>ativos em {wholeNumber.format(farms.length)} {farms.length === 1 ? 'fazenda' : 'fazendas'}</span></p>
          <HealthBar totals={charts ? totals : { online: 0, offline: 0, unknown: 0, manual: assetCount }} />
        </div>
        <ul className="park-stats" aria-label="Indicadores de operação">
          <li data-tone={online === withCollector && withCollector ? 'good' : 'warn'}>
            <span>Coletores em contato</span><strong>{wholeNumber.format(online)}<small>/{wholeNumber.format(withCollector)}</small></strong>
            <p>{farms.length - withCollector} {farms.length - withCollector === 1 ? 'fazenda sem coletor' : 'fazendas sem coletor'}</p>
          </li>
          <li data-tone={offlineCritical ? 'critical' : 'good'}>
            <span>Críticos offline</span><strong>{wholeNumber.format(offlineCritical)}</strong><p>Com estado offline confirmado</p>
          </li>
          <li data-tone={criticalOpen ? 'critical' : unacknowledged.length ? 'warn' : 'good'}>
            <span>Ocorrências abertas</span><strong>{wholeNumber.format(openOccurrences.length)}</strong><p>{unacknowledged.length} sem reconhecimento</p>
          </li>
          <li>
            <span>Cobertura UniFi</span><strong>{assetCount ? percent.format(unifiCount / assetCount) : '—'}</strong><p>{wholeNumber.format(unifiCount)} ativos observados pela coleta</p>
          </li>
        </ul>
      </section>

      {openOccurrences.length > 0 && (
        <section className={`panel occurrence-banner ${criticalOpen ? 'critical' : ''}`} aria-labelledby="occurrence-banner-title">
          <div className="panel-heading">
            <div>
              <h2 id="occurrence-banner-title"><BellRing size={18} aria-hidden="true" /> {openOccurrences.length} {openOccurrences.length === 1 ? 'ocorrência aberta' : 'ocorrências abertas'}</h2>
              <p>{unacknowledged.length ? `${unacknowledged.length} sem reconhecimento${criticalOpen ? `, ${criticalOpen} ${criticalOpen === 1 ? 'crítica' : 'críticas'}` : ''}.` : 'Todas reconhecidas pela equipe.'}</p>
            </div>
            <button className="button secondary" type="button" onClick={onOpenOccurrences}>Ver ocorrências <ArrowRight size={17} aria-hidden="true" /></button>
          </div>
          <ul className="park-feed" aria-label="Ocorrências mais urgentes">
            {feed.map((occurrence) => (
              <li key={occurrence.id} data-severity={occurrence.severity}>
                {occurrence.severity === 'critical' ? <CircleAlert size={16} aria-hidden="true" /> : <BellRing size={16} aria-hidden="true" />}
                <div><strong>{occurrence.title}</strong><span>{farmName.get(occurrence.farmId) ?? 'Fazenda'} · aberta {formatDate(occurrence.openedAt)}{occurrence.acknowledgedAt ? ' · reconhecida' : ''}</span></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="park-grid">
        <section className="panel park-map" aria-labelledby="map-title">
          <div className="panel-heading"><div><h2 id="map-title"><MapPinned size={18} aria-hidden="true" /> Mapa das fazendas</h2><p>Sede de cada fazenda com o estado do coletor. Selecione para abrir o inventário.</p></div></div>
          <FarmMap farms={farms} onOpenFarm={onOpenFarm} />
        </section>

        <section className="panel park-families" aria-labelledby="families-title">
          <div className="panel-heading"><div><h2 id="families-title">Famílias de ativos</h2><p>Classificadas pela categoria, nome e modelo cadastrados.</p></div></div>
          {!charts ? <p className="cell-detail park-loading" role="status">Carregando o parque…</p> : families.length === 0 ? (
            <EmptyState title="Inventário vazio">Importe a planilha ou ative um coletor para ver o parque.</EmptyState>
          ) : (
            <ul className="family-list">
              {families.map((family) => {
                const Icon = FAMILY_ICONS[family.family];
                const total = STATES.reduce((sum, state) => sum + family[state.key], 0);
                return (
                  <li key={family.family} className="family-tile">
                    <span className="family-icon"><Icon size={18} aria-hidden="true" /></span>
                    <div className="family-main">
                      <strong>{family.label}</strong>
                      <span>{family.vendors.length ? family.vendors.map((vendor) => `${vendorLabel(vendor.vendor)} ${vendor.total}`).join(' · ') : 'Fabricante não identificado'}</span>
                      <div className="family-bar" role="img" aria-label={STATES.map((state) => `${family[state.key]} ${state.label.toLowerCase()}`).join(', ')}>
                        {STATES.filter((state) => family[state.key]).map((state) => <span key={state.key} className={`viz-seg state-${state.key}`} style={{ flexGrow: family[state.key] }} />)}
                      </div>
                    </div>
                    <span className="family-count">{wholeNumber.format(total)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="farms-title">
        <div className="panel-heading">
          <div><h2 id="farms-title">Fazendas</h2><p>Comunicação do coletor, coleta UniFi e inventário por unidade.</p></div>
          <span className="count-label">{farms.length} {farms.length === 1 ? 'unidade' : 'unidades'}</span>
        </div>
        {orderedFarms.length === 0 ? (
          <EmptyState title="Nenhuma fazenda neste escopo">As unidades cadastradas aparecem aqui.</EmptyState>
        ) : (
          <ul className="farm-list">
            {orderedFarms.map((farm) => (
              <li className="farm-row" key={farm.id}>
                <div className="farm-name">
                  <span className="location-icon"><MapPin size={18} aria-hidden="true" /></span>
                  <div><strong>{farm.name}</strong><span>{farm.location}</span></div>
                </div>
                <div className="farm-signal">
                  <StatusBadge {...collectorStatus[farm.collectorStatus]} />
                  <small>{farm.lastHeartbeatAt ? `Sinal ${formatDate(farm.lastHeartbeatAt)}` : 'Sem sinal registrado'}</small>
                </div>
                <div className="farm-capture">
                  <small>Última coleta</small>
                  <span>{formatDate(farm.lastCaptureAt)}</span>
                  {farm.lastCaptureAt && !hasFreshCapture(farm.lastCaptureAt, generatedAt) && <small className="stale">Desatualizada</small>}
                </div>
                <div className="farm-assets"><small>Ativos</small><strong>{wholeNumber.format(farm.assetCount)}</strong></div>
                <button className="button icon-button open-farm" type="button" onClick={() => onOpenFarm(farm.id)} aria-label={`Ver inventário de ${farm.name}`}><ArrowRight size={18} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel inventory-summary" aria-labelledby="inventory-summary-title">
        <div className="panel-heading">
          <div><h2 id="inventory-summary-title">Inventário de ativos</h2><p>Consulte os equipamentos cadastrados por CSV e descobertos pelo UniFi.</p></div>
          <button className="button secondary" type="button" onClick={onOpenInventory}>Abrir inventário <ArrowRight size={17} aria-hidden="true" /></button>
        </div>
      </section>
    </div>
  );
}
