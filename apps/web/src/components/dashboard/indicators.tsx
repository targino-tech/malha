'use client';

import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { Indicators as IndicatorData } from '../../server/metrics';
import { EmptyState, formatDate, requestJson, wholeNumber } from './presentation';

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const weekLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Cuiaba', day: '2-digit', month: '2-digit' });

function duration(value: number | null) {
  if (value === null) return 'Sem dados';
  if (value < 60) return `${decimal.format(value)} min`;
  const hours = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const ratio = (part: number, total: number) => total ? percent.format(part / total) : 'Sem dados';

type Card = { title: string; value: string; detail: string; purpose: string };

function BaselineForm({ data, online, onSaved }: { data: IndicatorData['savings']['baseline']; online: boolean; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(String(form.get(name) ?? '').replace(',', '.'));
    setBusy(true);
    setError('');
    try {
      await requestJson('/api/baseline', { method: 'PUT', json: {
        diagnosisMinutes: Math.round(number('diagnosisMinutes')), travelHours: number('travelHours'),
        costPerHour: number('costPerHour'), costPerTrip: number('costPerTrip'),
      } });
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível salvar a linha de base.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="inline-form baseline-form" onSubmit={submit} aria-label="Linha de base">
      <label className="form-field">Diagnóstico antes do piloto (min)<input name="diagnosisMinutes" inputMode="numeric" required defaultValue={data?.diagnosisMinutes ?? ''} /></label>
      <label className="form-field">Horas por viagem à fazenda<input name="travelHours" inputMode="decimal" required defaultValue={data?.travelHours ?? ''} /></label>
      <label className="form-field">Custo por hora técnica (R$)<input name="costPerHour" inputMode="decimal" required defaultValue={data?.costPerHour ?? ''} /></label>
      <label className="form-field">Custo por viagem (R$)<input name="costPerTrip" inputMode="decimal" required defaultValue={data?.costPerTrip ?? ''} /></label>
      <button className="button primary" type="submit" disabled={!online || busy}>Salvar linha de base</button>
      {error && <p className="message danger" role="alert">{error}</p>}
    </form>
  );
}

export function Indicators({ farms, farmId, canExport, canBaseline, online }: {
  farms: DashboardFarm[]; farmId: string; canExport: boolean; canBaseline: boolean; online: boolean;
}) {
  const [days, setDays] = useState(30);
  const [reload, setReload] = useState(0);
  const requestKey = `${farmId}|${days}|${reload}`;
  const [result, setResult] = useState<{ key: string; data?: IndicatorData; error?: string }>();
  const farmNames = new Map(farms.map((farm) => [farm.id, farm.name]));

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ days: String(days) });
    if (farmId !== 'all') params.set('farmId', farmId);
    requestJson<IndicatorData>(`/api/indicators?${params}`).then(
      (data) => { if (active) setResult({ key: requestKey, data }); },
      (problem: unknown) => { if (active) setResult((previous) => ({ key: requestKey, data: previous?.data, error: problem instanceof Error ? problem.message : 'Falha ao calcular os indicadores.' })); },
    );
    return () => { active = false; };
  }, [farmId, days, requestKey]);

  const data = result?.data;
  if (!data) return result?.error ? <p className="message danger" role="alert">{result.error}</p> : <p className="empty-state" role="status">Calculando indicadores…</p>;

  const { coverage, inventory, detection, acknowledgement, savings } = data;
  const cards: Card[] = [
    { title: 'Cobertura de coleta UniFi', value: ratio(coverage.complete, coverage.eligible),
      detail: `${coverage.complete} de ${coverage.eligible} fazendas com coleta completa nos últimos 15 min · ${coverage.csvOnly} em modo CSV`,
      purpose: 'Mostra se a matriz enxerga as fazendas agora.' },
    { title: 'Inventário conferido', value: ratio(inventory.reviewed, inventory.reference),
      detail: `${inventory.reviewed} de ${inventory.reference} itens de referência · ${inventory.incomplete} incompletos · ${inventory.discoveredPending} descobertos pendentes`,
      purpose: 'Mede a confiança no cadastro patrimonial.' },
    { title: 'Tempo de detecção', value: duration(detection.medianMinutes),
      detail: detection.episodes ? `Mediana · P90 ${duration(detection.p90Minutes)} · ${detection.episodes} episódios · coleta a cada 5 min` : 'Nenhum episódio no período',
      purpose: 'Da primeira evidência offline até a abertura da ocorrência.' },
    { title: 'Tempo de reconhecimento', value: duration(acknowledgement.medianMinutes),
      detail: `${acknowledgement.acknowledged ? `Mediana de ${acknowledgement.acknowledged} reconhecidas` : 'Nenhuma reconhecida no período'} · ${acknowledgement.pending} abertas sem reconhecimento`,
      purpose: 'Da abertura até a primeira ação da equipe.' },
    { title: 'Horas economizadas', value: savings.hoursSaved === null ? 'Sem dados' : `${decimal.format(savings.hoursSaved)} h`,
      detail: !savings.baseline ? 'Defina a linha de base para calcular' : `${savings.services} atendimentos · ${savings.tripsAvoided} viagens evitadas`,
      purpose: 'Diagnóstico mais rápido e viagens evitadas, frente à linha de base.' },
    { title: 'Economia estimada', value: savings.costSaved === null ? 'Sem dados' : money.format(savings.costSaved),
      detail: savings.baseline ? `Valores aprovados em ${formatDate(savings.baseline.definedAt)}` : 'Usa os custos aprovados pelo cliente',
      purpose: 'Horas pelo custo técnico mais o custo das viagens evitadas.' },
  ];
  const exportParams = new URLSearchParams({ days: String(days) });
  if (farmId !== 'all') exportParams.set('farmId', farmId);

  return (
    <div className="content-stack">
      <div className="indicator-toolbar">
        <label className="filter-field">Período
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option>
          </select>
        </label>
        <p className="cell-detail">Desde {formatDate(data.from)}. Indicadores calculados no escopo das fazendas que você acessa.</p>
        {canExport && <a className="button secondary" href={`/api/exports/occurrences?${exportParams}&format=xlsx`} download><FileSpreadsheet size={16} aria-hidden="true" /> Evidências em planilha</a>}
        {canExport && <a className="button secondary" href={`/api/exports/occurrences?${exportParams}`} download><Download size={16} aria-hidden="true" /> CSV</a>}
      </div>
      {result?.error && <p className="message warning" role="status">{result.error} Exibindo o último cálculo.</p>}
      <ul className="indicator-grid" aria-label="Indicadores de valor">
        {cards.map((card) => (
          <li className="metric indicator" key={card.title}>
            <div className="metric-top"><span>{card.title}</span></div>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
            <p className="indicator-purpose">{card.purpose}</p>
          </li>
        ))}
      </ul>

      <section className="panel" aria-labelledby="weekly-title">
        <div className="panel-heading"><div><h2 id="weekly-title">Ocorrências por semana</h2><p>Episódios abertos por fazenda, semana iniciada na segunda-feira.</p></div></div>
        <div className="table-container" role="region" tabIndex={0} aria-label="Tabela de ocorrências por semana">
          <table>
            <thead><tr><th scope="col">Fazenda</th>{data.weekly.weeks.map((week) => <th scope="col" key={week}>{weekLabel.format(new Date(week))}</th>)}</tr></thead>
            <tbody>{data.weekly.farms.map((row) => (
              <tr key={row.farmId}><th scope="row">{farmNames.get(row.farmId) ?? 'Fazenda'}</th>
                {row.counts.map((value, index) => <td key={index} className={`technical ${value ? 'has-value' : ''}`}>{wholeNumber.format(value)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="services-title">
        <div className="panel-heading"><div><h2 id="services-title">Atendimentos no período</h2><p>Registrados a partir das ocorrências. Base da medição de economia.</p></div>
          <span className="count-label">{savings.services} registrados</span></div>
        {!data.services.length ? <EmptyState title="Sem atendimentos registrados">Use “Registrar atendimento” em uma ocorrência.</EmptyState> : (
          <ul className="admin-list" aria-label="Atendimentos registrados">
            {data.services.map((service) => (
              <li key={service.id}><div className="admin-row"><div>
                <strong>{service.occurrenceTitle ?? 'Atendimento avulso'}</strong>
                <span>{farmNames.get(service.farmId) ?? 'Fazenda'} · {formatDate(service.attendedAt)} · diagnóstico {duration(service.diagnosisMinutes)}{service.tripAvoided ? ' · viagem evitada' : ''}</span>
                {service.notes && <span>{service.notes}</span>}
              </div></div></li>
            ))}
          </ul>
        )}
      </section>

      {canBaseline && (
        <section className="panel" aria-labelledby="baseline-title">
          <div className="panel-heading"><div><h2 id="baseline-title">Linha de base</h2><p>Defina antes da instalação, com valores aprovados pelo cliente. Sem ela, a economia aparece como “Sem dados”.</p></div></div>
          <div className="admin-body"><BaselineForm key={savings.baseline?.definedAt ?? 'new'} data={savings.baseline} online={online} onSaved={() => setReload((value) => value + 1)} /></div>
        </section>
      )}
    </div>
  );
}
