import { ArrowRight, BellRing, Building2, CircleAlert, Database, MapPin, Radio } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { DashboardOccurrence } from '../../server/occurrences';
import { collectorStatus, EmptyState, formatDate, hasFreshCapture, StatusBadge, wholeNumber } from './presentation';

type OverviewProps = {
  farms: DashboardFarm[];
  generatedAt: string;
  openOccurrences: DashboardOccurrence[];
  onOpenOccurrences: () => void;
  onOpenFarm: (id: string) => void;
  onOpenInventory: () => void;
};

export function Overview({ farms, generatedAt, openOccurrences, onOpenOccurrences, onOpenFarm, onOpenInventory }: OverviewProps) {
  const unacknowledged = openOccurrences.filter((occurrence) => !occurrence.acknowledgedAt);
  const criticalOpen = unacknowledged.filter((occurrence) => occurrence.severity === 'critical').length;
  const recentFarms = farms.filter((farm) => farm.collectorStatus === 'online');
  const staleFarms = farms.filter((farm) => farm.collectorStatus === 'offline');
  const inventoryOnly = farms.filter((farm) => farm.collectorStatus === 'missing');
  const offlineCritical = farms.reduce((sum, farm) => sum + farm.offlineCriticalCount, 0);
  const assetCount = farms.reduce((sum, farm) => sum + farm.assetCount, 0);
  const unifiCount = farms.reduce((sum, farm) => sum + farm.unifiCount, 0);
  const orderedFarms = [...farms].sort((a, b) => {
    const priorities = { offline: 0, online: 1, missing: 2 };
    return priorities[a.collectorStatus] - priorities[b.collectorStatus] || a.name.localeCompare(b.name, 'pt-BR');
  });
  const cards = [
    { title: 'Fazendas no painel', value: farms.length, description: `${inventoryOnly.length} sem coletor`, icon: Building2, tone: 'normal' },
    { title: 'Coletores em contato', value: recentFarms.length, description: `${staleFarms.length} sem contato`, icon: Radio, tone: 'green' },
    { title: 'Ativos inventariados', value: assetCount, description: `${unifiCount} observados via UniFi`, icon: Database, tone: 'normal' },
    { title: 'Críticos offline', value: offlineCritical, description: 'Com estado offline confirmado', icon: CircleAlert, tone: offlineCritical ? 'amber' : 'normal' },
  ];

  return (
    <div className="content-stack">
      <ul className="metrics" aria-label="Indicadores de operação">
        {cards.map(({ title, value, description, icon: Icon, tone }) => (
          <li className={`metric ${tone}`} key={title}>
            <div className="metric-top"><span>{title}</span><span className="metric-icon"><Icon size={17} aria-hidden="true" /></span></div>
            <strong>{wholeNumber.format(value)}</strong>
            <p>{description}</p>
          </li>
        ))}
      </ul>

      {openOccurrences.length > 0 && (
        <section className={`panel occurrence-banner ${criticalOpen ? 'critical' : ''}`} aria-labelledby="occurrence-banner-title">
          <div className="panel-heading">
            <div>
              <h2 id="occurrence-banner-title"><BellRing size={18} aria-hidden="true" /> {openOccurrences.length} {openOccurrences.length === 1 ? 'ocorrência aberta' : 'ocorrências abertas'}</h2>
              <p>{unacknowledged.length ? `${unacknowledged.length} sem reconhecimento${criticalOpen ? `, ${criticalOpen} ${criticalOpen === 1 ? 'crítica' : 'críticas'}` : ''}.` : 'Todas reconhecidas pela equipe.'}</p>
            </div>
            <button className="button secondary" type="button" onClick={onOpenOccurrences}>Ver ocorrências <ArrowRight size={17} aria-hidden="true" /></button>
          </div>
        </section>
      )}

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
