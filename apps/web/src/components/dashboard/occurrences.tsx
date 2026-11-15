'use client';

import { useState } from 'react';
import { BellRing, CheckCheck, CircleAlert, CircleCheck, ClipboardPen, TriangleAlert } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { DashboardOccurrence } from '../../server/occurrences';
import { Modal } from './modal';
import { EmptyState, formatDate, fromLocalInput, requestJson, StatusBadge, toLocalInput } from './presentation';

function ServiceForm({ occurrence, timezone, online, onSaved, onClose }: {
  occurrence: DashboardOccurrence; timezone: string; online: boolean; onSaved: () => void; onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => new Date().toISOString());
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await requestJson('/api/services', { method: 'POST', json: {
        occurrenceId: occurrence.id,
        attendedAt: fromLocalInput(String(form.get('attendedAt')), timezone),
        diagnosisMinutes: Number(form.get('diagnosisMinutes')),
        tripAvoided: form.get('tripAvoided') === 'on',
        notes: String(form.get('notes') ?? ''),
      } });
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível registrar o atendimento.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Registrar atendimento" labelId="service-title" onClose={onClose}>
      <form className="asset-form" onSubmit={submit}>
        <p className="cell-detail">{occurrence.title}</p>
        <label className="form-field">Data e hora do atendimento<input name="attendedAt" type="datetime-local" required defaultValue={toLocalInput(now, timezone)} /></label>
        <label className="form-field">Tempo de diagnóstico (min)<input name="diagnosisMinutes" type="number" min={0} max={10080} required inputMode="numeric" /></label>
        <label className="check-field"><input name="tripAvoided" type="checkbox" /> Viagem à fazenda evitada</label>
        <label className="form-field">Observações<textarea name="notes" maxLength={1000} rows={3} /></label>
        {error && <p className="message danger" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>Cancelar</button>
          <button className="button primary" type="submit" disabled={!online || busy}>{busy ? 'Salvando…' : 'Registrar'}</button>
        </div>
      </form>
    </Modal>
  );
}

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
  const [servicing, setServicing] = useState<DashboardOccurrence>();
  const [notice, setNotice] = useState('');
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
      {notice && <p className="message success occurrence-error" role="status">{notice}</p>}
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
                {canAcknowledge && (
                  <button className="button secondary" type="button" disabled={!online} onClick={() => { setNotice(''); setServicing(occurrence); }}
                    aria-label={`Registrar atendimento: ${occurrence.title}`}>
                    <ClipboardPen size={16} aria-hidden="true" /> Atendimento
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {servicing && (
        <ServiceForm occurrence={servicing} timezone={farms.find((farm) => farm.id === servicing.farmId)?.timezone ?? 'America/Cuiaba'} online={online}
          onClose={() => setServicing(undefined)} onSaved={() => { setServicing(undefined); setNotice('Atendimento registrado.'); }} />
      )}
    </section>
  );
}
