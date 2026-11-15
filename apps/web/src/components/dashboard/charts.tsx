'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, CircleX, FileText, Table2, TriangleAlert, ChartColumn } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { AssetState, Charts } from '../../server/charts';
import { EmptyState, requestJson, wholeNumber } from './presentation';

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dayLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
const dayLong = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'long' });

// Estados usam a paleta de status fixa e sempre aparecem com ícone e rótulo; offline leva hachura
// como segunda codificação, porque verde e vermelho lado a lado se confundem para daltônicos.
const STATES: Array<{ key: AssetState; label: string; icon: typeof CircleCheck }> = [
  { key: 'online', label: 'Em contato', icon: CircleCheck },
  { key: 'offline', label: 'Offline', icon: CircleX },
  { key: 'unknown', label: 'Indeterminado', icon: CircleHelp },
  { key: 'manual', label: 'Sem telemetria', icon: FileText },
];
const SEVERITIES = [
  { key: 'critical', label: 'Crítica', icon: CircleX },
  { key: 'warning', label: 'Aviso', icon: TriangleAlert },
] as const;

function minutesLabel(value: number) {
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (value <= factor * step) return factor * step;
  return 10 * step;
}

type Tip = { x: number; y: number; title: string; rows: Array<{ label: string; value: string; swatch?: string }> } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="viz-tooltip" style={{ left: tip.x, top: tip.y }} role="presentation">
      <span className="viz-tooltip-title">{tip.title}</span>
      {tip.rows.map((row) => (
        <span className="viz-tooltip-row" key={row.label}>
          {row.swatch && <i className={`viz-key ${row.swatch}`} aria-hidden="true" />}
          <strong>{row.value}</strong> <span>{row.label}</span>
        </span>
      ))}
    </div>
  );
}

function ChartCard({ id, title, description, legend, table, children }: {
  id: string; title: string; description: string; legend?: ReactNode; table: ReactNode; children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="panel viz-card" aria-labelledby={id}>
      <div className="panel-heading">
        <div><h2 id={id}>{title}</h2><p>{description}</p></div>
        <button type="button" className="button secondary viz-toggle" aria-pressed={showTable} onClick={() => setShowTable((value) => !value)}>
          {showTable ? <ChartColumn size={16} aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />} {showTable ? 'Ver gráfico' : 'Ver tabela'}
        </button>
      </div>
      <div className="viz-body">
        {legend && !showTable && <div className="viz-legend">{legend}</div>}
        {showTable ? <div className="table-container" role="region" tabIndex={0} aria-label={`Tabela: ${title}`}>{table}</div> : children}
      </div>
    </section>
  );
}

function LegendItem({ swatch, label, icon: Icon }: { swatch: string; label: string; icon?: typeof CircleCheck }) {
  return (
    <span className="viz-legend-item">
      <i className={`viz-swatch ${swatch}`} aria-hidden="true" />
      {Icon && <Icon size={14} aria-hidden="true" />}
      {label}
    </span>
  );
}

function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const ref = useRef<HTMLDivElement>(null);
  function place(target: HTMLElement, content: Omit<NonNullable<Tip>, 'x' | 'y'>) {
    const host = ref.current?.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    if (!host) return;
    setTip({ ...content, x: Math.min(host.width - 200, Math.max(0, box.left - host.left + box.width / 2 - 100)), y: box.top - host.top - 8 });
  }
  return { tip, ref, place, clear: () => setTip(null) };
}

function StateBars({ data }: { data: Charts['assetStates'] }) {
  const { tip, ref, place, clear } = useTip();
  const max = Math.max(1, ...data.map((row) => row.online + row.offline + row.unknown + row.manual));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((step) => Math.round(niceMax(max) * step));
  const scale = niceMax(max);
  if (!data.length) return <EmptyState title="Nenhuma fazenda neste escopo">As fazendas cadastradas aparecem aqui.</EmptyState>;
  return (
    <div className="viz-plot" ref={ref} onPointerLeave={clear}>
      <div className="viz-hbars">
        {data.map((row) => {
          const total = row.online + row.offline + row.unknown + row.manual;
          const rows = STATES.map((state) => ({ label: state.label, value: wholeNumber.format(row[state.key]), swatch: `state-${state.key}` }));
          const show = (event: React.PointerEvent<HTMLElement> | React.FocusEvent<HTMLElement>) =>
            place(event.currentTarget, { title: `${row.name} · ${wholeNumber.format(total)} ativos`, rows });
          return (
            <div className="viz-hbar-row" key={row.farmId}>
              <span className="viz-hbar-label">{row.name}</span>
              <div className="viz-hbar-track" tabIndex={0} onPointerMove={show} onFocus={show} onBlur={clear}
                aria-label={`${row.name}: ${STATES.map((state) => `${row[state.key]} ${state.label.toLowerCase()}`).join(', ')}`}>
                <div className="viz-hbar-area">
                  <div className="viz-hbar" style={{ width: `${(total / scale) * 100}%` }}>
                    {STATES.filter((state) => row[state.key] > 0).map((state) => (
                      <span key={state.key} className={`viz-seg state-${state.key}`} style={{ flexGrow: row[state.key] }} />
                    ))}
                  </div>
                </div>
                <span className="viz-hbar-value">{wholeNumber.format(total)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="viz-axis-x" aria-hidden="true"><div>{ticks.map((tick, index) => <span key={tick} style={{ left: `${index * 25}%` }}>{wholeNumber.format(tick)}</span>)}</div></div>
      <Tooltip tip={tip} />
    </div>
  );
}

function DailyColumns({ data, labelId }: { data: Charts['occurrencesByDay']; labelId: string }) {
  const { tip, ref, place, clear } = useTip();
  const [active, setActive] = useState<number | null>(null);
  const columns = useRef<Array<HTMLDivElement | null>>([]);
  const max = niceMax(Math.max(1, ...data.map((day) => day.critical + day.warning)));
  const ticks = [max, max / 2, 0];
  const total = data.reduce((sum, day) => sum + day.critical + day.warning, 0);
  const step = data.length > 31 ? 14 : 7;

  function show(index: number) {
    const day = data[index];
    const node = columns.current[index];
    if (!day || !node) return;
    setActive(index);
    place(node, { title: dayLong.format(new Date(`${day.day}T00:00:00Z`)), rows: SEVERITIES.map((severity) => ({
      label: severity.label, value: wholeNumber.format(day[severity.key]), swatch: `sev-${severity.key}` })) });
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = active ?? data.length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? data.length - 1
      : Math.min(data.length - 1, Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1)));
    show(next);
  }
  if (!total) return <EmptyState title="Nenhuma ocorrência no período">Quando uma regra abrir um episódio, ele aparece aqui por dia.</EmptyState>;
  const activeDay = active === null ? null : data[active];
  return (
    <div className="viz-plot" ref={ref} onPointerLeave={() => { clear(); setActive(null); }}>
      <div className="viz-columns-wrap">
        <div className="viz-axis-y" aria-hidden="true">{ticks.map((tick) => <span key={tick}>{wholeNumber.format(tick)}</span>)}</div>
        <div className="viz-columns" tabIndex={0} role="group" aria-labelledby={labelId} aria-describedby={`${labelId}-hint`}
          onKeyDown={onKey} onFocus={() => show(active ?? data.length - 1)} onBlur={() => { clear(); setActive(null); }}>
          {data.map((day, index) => (
            <div key={day.day} ref={(node) => { columns.current[index] = node; }} className="viz-column" data-active={active === index || undefined}
              onPointerMove={() => show(index)}>
              <div className="viz-column-stack" style={{ height: `${((day.critical + day.warning) / max) * 100}%` }}>
                {day.warning > 0 && <span className="viz-seg sev-warning" style={{ flexGrow: day.warning }} />}
                {day.critical > 0 && <span className="viz-seg sev-critical" style={{ flexGrow: day.critical }} />}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="viz-axis-days" aria-hidden="true">
        {data.map((day, index) => <span key={day.day}>{(data.length - 1 - index) % step === 0 ? dayLabel.format(new Date(`${day.day}T00:00:00Z`)) : ''}</span>)}
      </div>
      <p id={`${labelId}-hint`} className="visually-hidden">Use as setas para percorrer os dias.</p>
      <p className="visually-hidden" aria-live="polite">{activeDay ? `${dayLong.format(new Date(`${activeDay.day}T00:00:00Z`))}: ${activeDay.critical} críticas, ${activeDay.warning} avisos` : ''}</p>
      <Tooltip tip={tip} />
    </div>
  );
}

function SingleBars({ rows, empty, axis, unit = 1 }: {
  rows: Array<{ key: string; label: string; value: number; display: string; detail: string }>; empty: ReactNode; axis: (value: number) => string;
  /** Escala arredondada nesta unidade (60 = horas inteiras para valores em minutos). */
  unit?: number;
}) {
  const { tip, ref, place, clear } = useTip();
  if (!rows.length) return <>{empty}</>;
  const scale = niceMax(Math.max(1, ...rows.map((row) => row.value / unit))) * unit;
  const steps = unit > 1 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const ticks = steps.map((step) => scale * step);
  return (
    <div className="viz-plot" ref={ref} onPointerLeave={clear}>
      <div className="viz-hbars">
        {rows.map((row) => {
          const show = (event: React.PointerEvent<HTMLElement> | React.FocusEvent<HTMLElement>) =>
            place(event.currentTarget, { title: row.label, rows: [{ label: row.detail, value: row.display }] });
          return (
            <div className="viz-hbar-row" key={row.key}>
              <span className="viz-hbar-label">{row.label}</span>
              <div className="viz-hbar-track" tabIndex={0} onPointerMove={show} onFocus={show} onBlur={clear} aria-label={`${row.label}: ${row.display}, ${row.detail}`}>
                <div className="viz-hbar-area">
                  <div className="viz-hbar" style={{ width: `${Math.max(0.5, (row.value / scale) * 100)}%` }}><span className="viz-seg series" style={{ flexGrow: 1 }} /></div>
                </div>
                <span className="viz-hbar-value">{row.display}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="viz-axis-x" aria-hidden="true"><div>{ticks.map((tick, index) => <span key={tick} style={{ left: `${(index / (ticks.length - 1)) * 100}%` }}>{axis(tick)}</span>)}</div></div>
      <Tooltip tip={tip} />
    </div>
  );
}

export function ChartsView({ farms, farmId, online }: { farms: DashboardFarm[]; farmId: string; online: boolean }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Charts | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dailyId = useId();

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ days: String(days) });
    if (farmId !== 'all') params.set('farmId', farmId);
    // Ao recarregar, o quadro anterior continua visível com opacidade reduzida.
    queueMicrotask(() => setLoading(true));
    requestJson<Charts>(`/api/charts?${params}`, { signal: controller.signal })
      .then((result) => { setData(result); setError(''); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os gráficos.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, farmId, online]);

  const farmCount = farms.length;
  return (
    <div className="content-stack">
      <div className="indicator-toolbar">
        <label className="filter-field">Período
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option>
          </select>
        </label>
        <p className="cell-detail">{farmId === 'all' ? `${farmCount} ${farmCount === 1 ? 'fazenda' : 'fazendas'} no escopo.` : 'Filtrado pela fazenda selecionada.'} Horários de Cuiabá.</p>
      </div>
      {error && <p className="message warning" role="status">{error}{data ? ' Exibindo o último carregamento.' : ''}</p>}
      {!data ? (loading ? <p className="cell-detail" role="status">Carregando gráficos…</p> : null) : (
        <div className="viz-grid" data-loading={loading || undefined} aria-busy={loading}>
          <ChartCard id="chart-states" title="Estado dos ativos por fazenda" description="Situação atual de cada ativo inventariado."
            legend={STATES.map((state) => <LegendItem key={state.key} swatch={`state-${state.key}`} label={state.label} icon={state.icon} />)}
            table={(
              <table>
                <thead><tr><th scope="col">Fazenda</th>{STATES.map((state) => <th scope="col" key={state.key}>{state.label}</th>)}<th scope="col">Total</th></tr></thead>
                <tbody>{data.assetStates.map((row) => (
                  <tr key={row.farmId}><th scope="row">{row.name}</th>{STATES.map((state) => <td key={state.key} className="technical">{wholeNumber.format(row[state.key])}</td>)}
                    <td className="technical">{wholeNumber.format(row.online + row.offline + row.unknown + row.manual)}</td></tr>
                ))}</tbody>
              </table>
            )}>
            <StateBars data={data.assetStates} />
          </ChartCard>

          <ChartCard id={dailyId} title="Ocorrências abertas por dia" description={`Episódios abertos nos últimos ${data.periodDays} dias, por severidade.`}
            legend={SEVERITIES.map((severity) => <LegendItem key={severity.key} swatch={`sev-${severity.key}`} label={severity.label} icon={severity.icon} />)}
            table={(
              <table>
                <thead><tr><th scope="col">Dia</th><th scope="col">Críticas</th><th scope="col">Avisos</th></tr></thead>
                <tbody>{data.occurrencesByDay.filter((day) => day.critical + day.warning).map((day) => (
                  <tr key={day.day}><th scope="row">{dayLong.format(new Date(`${day.day}T00:00:00Z`))}</th>
                    <td className="technical">{wholeNumber.format(day.critical)}</td><td className="technical">{wholeNumber.format(day.warning)}</td></tr>
                ))}</tbody>
              </table>
            )}>
            <DailyColumns data={data.occurrencesByDay} labelId={dailyId} />
          </ChartCard>

          <ChartCard id="chart-availability" title="Tempo sem contato por coletor" description={`Soma dos episódios de coletor sem contato nos últimos ${data.periodDays} dias, com a disponibilidade resultante. Pior primeiro.`}
            table={(
              <table>
                <thead><tr><th scope="col">Fazenda</th><th scope="col">Disponibilidade</th><th scope="col">Sem contato</th></tr></thead>
                <tbody>{data.availability.map((row) => (
                  <tr key={row.farmId}><th scope="row">{row.name}</th><td className="technical">{percent.format(row.ratio)}</td><td className="technical">{minutesLabel(row.silentMinutes)}</td></tr>
                ))}</tbody>
              </table>
            )}>
            <SingleBars unit={60} axis={(value) => `${wholeNumber.format(value / 60)} h`} empty={<EmptyState title="Nenhum coletor ativo">Ative um coletor em Integrações para medir a disponibilidade.</EmptyState>}
              rows={[...data.availability].sort((a, b) => b.silentMinutes - a.silentMinutes).map((row) => ({
                key: row.farmId, label: row.name, value: row.silentMinutes, display: minutesLabel(row.silentMinutes), detail: `${percent.format(row.ratio)} de disponibilidade` }))} />
          </ChartCard>

          <ChartCard id="chart-categories" title="Ativos por categoria" description="Inventário ativo, das categorias mais comuns para as menos comuns."
            table={(
              <table>
                <thead><tr><th scope="col">Categoria</th><th scope="col">Ativos</th></tr></thead>
                <tbody>{data.categories.map((row) => <tr key={row.category}><th scope="row">{row.category}</th><td className="technical">{wholeNumber.format(row.total)}</td></tr>)}</tbody>
              </table>
            )}>
            <SingleBars axis={(value) => wholeNumber.format(value)} empty={<EmptyState title="Inventário vazio">Importe a planilha ou ative um coletor para ver as categorias.</EmptyState>}
              rows={data.categories.map((row) => ({ key: row.category, label: row.category, value: row.total, display: wholeNumber.format(row.total), detail: 'ativos' }))} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
