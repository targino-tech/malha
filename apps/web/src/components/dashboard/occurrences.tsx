'use client';

import { useState } from 'react';
import { BellRing, CheckCheck, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { DashboardOccurrence } from '../../server/occurrences';
import { EmptyState, formatDate, StatusBadge } from './presentation';

const ruleLabels: Record<DashboardOccurrence['rule'], string> = {
  collector_silent: 'Coletor sem contato',
  capture_stale: 'Coleta UniFi desatualizada',
  asset_offline: 'Ativo offline',
  asset_missing: 'Divergência de inventário',
};

function stateBadge(occurrence: DashboardOccurrence) {
  if (occurrence.resolvedAt) return <StatusBadge label="Encerrada" icon={CircleCheck} tone="healthy" />;
  if (occurrence.acknowledgedAt) return <StatusBadge label="Reconhecida" icon={CheckCheck} tone="neutral" />;
  return occurrence.severity === 'critical'
    ? <StatusBadge label="Crítica" icon={CircleAlert} tone="critical" />
    : <StatusBadge label="Atenção" icon={TriangleAlert} tone="warning" />;
}

type OccurrencesProps = {
  occurrences: DashboardOccurrence[];
  farms: DashboardFarm[];
  canAcknowledge: boolean;
  online: boolean;
  onChanged: () => void;
};

export function Occurrences({ occurrences, farms, canAcknowledge, online, onChanged }: OccurrencesProps) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const farmNames = new Map(farms.map((farm) => [farm.id, farm.name]));
  const scoped = occurrences.filter((occurrence) => farmNames.has(occurrence.farmId));
  const visible = scoped.filter((occurrence) => filter === 'all' || !occurrence.resolvedAt);
  const openCount = scoped.filter((occurrence) => !occurrence.resolvedAt).length;

  async function acknowledge(id: string) {
    setPending(id);
    setError(undefined);
    try {
      const response = await fetch(`/api/occurrences/${id}/acknowledge`, { method: 'POST', cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'Não foi possível reconhecer a ocorrência.');
      }
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível reconhecer a ocorrência.');
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="panel" aria-labelledby="occurrences-title">
      <div className="panel-heading occurrence-heading">
        <div><h2 id="occurrences-title">Ocorrências</h2><p>Episódios abertos pelo Malha a partir do coletor e das capturas UniFi.</p></div>
        <label className="filter-field" htmlFor="occurrence-filter">Exibir
          <select id="occurrence-filter" value={filter} onChange={(event) => setFilter(event.target.value as 'open' | 'all')}>
            <option value="open">Abertas ({openCount})</option>
            <option value="all">Incluir encerradas nos últimos 7 dias</option>
          </select>
        </label>
      </div>
      {error && <p className="message danger occurrence-error" role="alert">{error}</p>}
      {visible.length === 0 ? (
        <EmptyState title={filter === 'open' ? 'Nenhuma ocorrência aberta' : 'Nenhuma ocorrência no período'}>
          As regras são avaliadas a cada minuto.
        </EmptyState>
      ) : (
        <ul className="occurrence-list" aria-label="Lista de ocorrências">
          {visible.map((occurrence) => (
            <li className="occurrence-row" key={occurrence.id}>
              <span className={`occurrence-icon ${occurrence.resolvedAt ? 'resolved' : occurrence.severity}`}><BellRing size={18} aria-hidden="true" /></span>
              <div className="occurrence-main">
                <strong>{occurrence.title}</strong>
                <span>{farmNames.get(occurrence.farmId)}{occurrence.title.startsWith(ruleLabels[occurrence.rule]) ? '' : ` · ${ruleLabels[occurrence.rule]}`}</span>
              </div>
              <dl className="occurrence-times">
                <div><dt>Aberta</dt><dd><time dateTime={occurrence.openedAt}>{formatDate(occurrence.openedAt)}</time></dd></div>
                <div><dt>{occurrence.resolvedAt ? 'Encerrada' : 'Evidência desde'}</dt><dd>{formatDate(occurrence.resolvedAt ?? occurrence.firstObservedAt)}</dd></div>
              </dl>
              <div className="occurrence-actions">
                {stateBadge(occurrence)}
                {canAcknowledge && !occurrence.acknowledgedAt && !occurrence.resolvedAt && (
                  <button className="button secondary" type="button" disabled={!online || pending === occurrence.id}
                    onClick={() => { void acknowledge(occurrence.id); }} aria-label={`Reconhecer: ${occurrence.title}`}>
                    <CheckCheck size={16} aria-hidden="true" /> Reconhecer
                  </button>
                )}
                {occurrence.acknowledgedAt && !occurrence.resolvedAt && <small>Reconhecida {formatDate(occurrence.acknowledgedAt)}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
