'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Activity, ArrowDownToLine, ArrowUpFromLine, CircleAlert, CircleX, Cable, FlaskConical, Gauge, Network, PlugZap, Unplug } from 'lucide-react';
import type { HeatPort, NetworkPanel as Panel, PanelSwitch } from '../../server/network/panel';
import type { TrafficPeriod, TrafficPoint } from '../../server/network/types';
import { ChartCard, LegendItem, SingleBars, Tooltip, type Tip } from './charts';
import {
  areaPath, formatBits, gapThreshold, formatBytes, formatCount, formatPercent, formatPower, HEAT_LEVELS, heatLevel, linePath, nearestIndex, niceCeiling, project, segments,
} from './network-format';
import { EmptyState, requestJson } from './presentation';

const PERIODS: Array<{ value: TrafficPeriod; label: string }> = [
  { value: '24h', label: 'Últimas 24 horas' }, { value: '7d', label: 'Últimos 7 dias' }, { value: '30d', label: 'Últimos 30 dias' },
];
const ZONE = 'America/Cuiaba';
const hourLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, day: '2-digit', month: '2-digit' });
const fullLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ROLE_LABEL: Record<string, string> = { gateway: 'Gateway', switch: 'Switch', ap: 'Ponto de acesso', radio: 'Rádio', other: 'Dispositivo' };

/** IDs do React (com dois-pontos ou «») não servem em url(#…) de SVG. */
const svgId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '');

// ------------------------------------------------------------------------------------------- indicadores

function Kpi({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Activity; tone?: 'alert' | 'muted' }) {
  return (
    <li className="net-kpi" data-tone={tone}>
      <span className="net-kpi-label"><Icon size={15} aria-hidden="true" />{label}</span>
      <strong>{value}</strong>
      <span className="net-kpi-detail">{detail}</span>
    </li>
  );
}

function Kpis({ kpis }: { kpis: Panel['kpis'] }) {
  const { ports, utilization, errors, poe, vlans, devices } = kpis;
  return (
    <ul className="net-kpis" aria-label="Indicadores de rede">
      <Kpi icon={Cable} label="Portas ativas" value={formatCount(ports.up)}
        detail={ports.total ? `de ${formatCount(ports.total)} portas em ${formatCount(ports.devices)} ${ports.devices === 1 ? 'dispositivo' : 'dispositivos'}` : 'Portas ainda não lidas'} />
      <Kpi icon={Unplug} label="Portas inativas" value={formatCount(ports.down)} tone={ports.down ? undefined : 'muted'}
        detail={ports.other ? `${formatCount(ports.other)} sem estado informado` : 'Sem enlace no momento da leitura'} />
      <Kpi icon={Gauge} label="Utilização média" value={utilization ? formatPercent(utilization.avg) : '—'} tone={utilization ? undefined : 'muted'}
        detail={utilization ? `${formatCount(utilization.ports)} ${utilization.ports === 1 ? 'porta medida' : 'portas medidas'} no período` : 'A fonte não expõe contadores por porta'} />
      <Kpi icon={Activity} label="Pico de utilização" value={utilization ? formatPercent(utilization.peak) : '—'} tone={utilization && utilization.peak >= 0.75 ? 'alert' : utilization ? undefined : 'muted'}
        detail={utilization ? `Porta ${utilization.peakPort.idx} de ${utilization.peakPort.name}, ${fullLabel.format(new Date(utilization.peakAt))}` : 'Sem série por porta no período'} />
      <Kpi icon={CircleAlert} label="Erros nas portas" value={errors ? formatCount(errors.rxErrors + errors.txErrors) : '—'} tone={errors ? (errors.rxErrors + errors.txErrors ? 'alert' : undefined) : 'muted'}
        detail={errors ? `${formatCount(errors.rxDropped + errors.txDropped)} descartes · contadores acumulados` : 'A fonte não expõe contadores por porta'} />
      <Kpi icon={PlugZap} label="PoE consumido" value={poe.powerMw === null ? '—' : formatPower(poe.powerMw)} tone={poe.powerMw === null ? 'muted' : undefined}
        detail={poe.powerMw === null ? `${formatCount(poe.activePorts)} portas PoE ativas · potência não informada` : `${formatCount(poe.activePorts)} portas PoE ativas`} />
      <Kpi icon={Network} label="VLANs ativas" value={formatCount(vlans.enabled)} tone={vlans.total ? undefined : 'muted'}
        detail={vlans.total ? `de ${formatCount(vlans.total)} redes no catálogo` : 'Nenhuma rede lida do console'} />
      <Kpi icon={CircleX} label="Dispositivos offline" value={formatCount(devices.offline)} tone={devices.offline ? 'alert' : 'muted'}
        detail={`de ${formatCount(devices.total)} ${devices.total === 1 ? 'dispositivo de rede' : 'dispositivos de rede'}`} />
    </ul>
  );
}

// ------------------------------------------------------------------------------------------- tráfego

const W = 720;
const H = 200;

function timeTick(value: number, period: TrafficPeriod) {
  return period === '24h' ? hourLabel.format(new Date(value)) : dayLabel.format(new Date(value));
}

function TrafficArea({ data, labelId }: { data: Panel; labelId: string }) {
  const gradient = svgId(useId());
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const points = data.traffic;
  const from = Date.parse(data.from);
  const to = Date.parse(data.to);
  if (!points.length) return <EmptyState title="Sem tráfego no período">Quando o coletor informar a taxa de uplink, a série aparece aqui. Intervalos sem amostra ficam em branco.</EmptyState>;
  const max = niceCeiling(Math.max(...points.map((point) => Math.max(point.rxBps, point.txBps))));
  const frame = { from, to, width: W, height: H, max };
  const parts = segments(points, gapThreshold(points, data.bucketSeconds));
  const series = [
    { key: 'rx', value: (point: TrafficPoint) => point.rxBps },
    { key: 'tx', value: (point: TrafficPoint) => point.txBps },
  ] as const;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((step) => from + step * (to - from));
  const current = active === null ? null : points[active];
  const ratioOf = (point: TrafficPoint) => Math.min(1, Math.max(0, (Date.parse(point.t) - from) / Math.max(1, to - from)));

  let tip: Tip = null;
  if (current && width) {
    tip = {
      x: Math.min(width - 200, Math.max(0, ratioOf(current) * width - 100)), y: 8,
      title: fullLabel.format(new Date(current.t)),
      rows: [
        { label: 'recebido (RX)', value: formatBits(current.rxBps), swatch: 'net-key-rx' },
        { label: 'enviado (TX)', value: formatBits(current.txBps), swatch: 'net-key-tx' },
        { label: 'pico RX no intervalo', value: formatBits(current.rxMaxBps) },
      ],
    };
  }
  function onPointer(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    setWidth(box.width);
    setActive(nearestIndex(points, (event.clientX - box.left) / Math.max(1, box.width), from, to));
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -12, PageDown: 12 };
    if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    setWidth(event.currentTarget.clientWidth);
    const start = active ?? points.length - 1;
    setActive(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.min(points.length - 1, Math.max(0, start + moves[event.key])));
  }
  return (
    <div className="viz-plot net-area">
      <div className="net-area-wrap">
        <div className="viz-axis-y net-axis-y" aria-hidden="true">{[max, max / 2, 0].map((tick) => <span key={tick}>{formatBits(tick)}</span>)}</div>
        <div className="net-area-plot" tabIndex={0} role="group" aria-labelledby={labelId} aria-describedby={`${labelId}-hint`}
          onPointerMove={onPointer} onPointerLeave={() => setActive(null)} onKeyDown={onKey}
          onFocus={(event) => { setWidth(event.currentTarget.clientWidth); setActive((value) => value ?? points.length - 1); }} onBlur={() => setActive(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <defs>
              {series.map((item) => (
                <linearGradient key={item.key} id={`${gradient}-${item.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" className={`net-stop-${item.key} top`} />
                  <stop offset="1" className={`net-stop-${item.key} bottom`} />
                </linearGradient>
              ))}
            </defs>
            {series.map((item) => parts.map((part) => {
              const samples = project(part, item.value, frame);
              return (
                <g key={`${item.key}-${part[0].t}`}>
                  <path d={areaPath(samples, H, 3)} fill={`url(#${gradient}-${item.key})`} />
                  {samples.length > 1 && <path d={linePath(samples)} className={`net-line-${item.key}`} fill="none" vectorEffect="non-scaling-stroke" />}
                </g>
              );
            }))}
          </svg>
          {current && <span className="net-cursor" style={{ left: `${ratioOf(current) * 100}%` }} aria-hidden="true" />}
          <Tooltip tip={tip} />
        </div>
      </div>
      <div className="net-axis-x" aria-hidden="true">{ticks.map((tick, index) => <span key={tick} style={{ left: `${index * 25}%` }}>{timeTick(tick, data.period)}</span>)}</div>
      <p id={`${labelId}-hint`} className="visually-hidden">Use as setas para percorrer os intervalos; Page Up e Page Down saltam 12 intervalos.</p>
      <p className="visually-hidden" aria-live="polite">{current ? `${fullLabel.format(new Date(current.t))}: recebido ${formatBits(current.rxBps)}, enviado ${formatBits(current.txBps)}` : ''}</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- fazendas

function Sparkline({ farm, from, to, max, gap, id }: { farm: Panel['farms'][number]; from: number; to: number; max: number; gap: number; id: string }) {
  const width = 160;
  const height = 32;
  const frame = { from, to, width, height, max };
  const parts = segments(farm.spark, gap);
  return (
    <svg className="net-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="net-stop-rx top" /><stop offset="1" className="net-stop-rx bottom" /></linearGradient>
      </defs>
      {parts.map((part) => {
        const samples = project(part, (point) => point.bps, frame);
        return (
          <g key={part[0].t}>
            <path d={areaPath(samples, height, 2)} fill={`url(#${id})`} />
            {samples.length > 1 && <path d={linePath(samples)} className="net-line-rx" fill="none" vectorEffect="non-scaling-stroke" />}
          </g>
        );
      })}
    </svg>
  );
}

function FarmSparklines({ data }: { data: Panel }) {
  const base = svgId(useId());
  const from = Date.parse(data.from);
  const to = Date.parse(data.to);
  // Escala comum: as fazendas ficam comparáveis entre si.
  const max = niceCeiling(Math.max(1, ...data.farms.flatMap((farm) => farm.spark.map((point) => point.bps))));
  const farms = [...data.farms].sort((a, b) => (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes) || a.name.localeCompare(b.name, 'pt-BR'));
  if (!farms.length) return <EmptyState title="Nenhuma fazenda neste escopo">As fazendas cadastradas aparecem aqui.</EmptyState>;
  return (
    <ul className="net-sparks">
      {farms.map((farm, index) => {
        const volume = farm.rxBytes + farm.txBytes;
        const summary = farm.spark.length
          ? `${farm.name}: ${formatBytes(volume)} no período, pico de ${formatBits(farm.peakBps)}`
          : `${farm.name}: sem tráfego no período`;
        return (
          <li key={farm.farmId} className="net-spark-row" tabIndex={0} aria-label={summary}>
            <span className="net-spark-name">{farm.name}</span>
            {farm.spark.length ? <Sparkline farm={farm} from={from} to={to} max={max} gap={gapThreshold(farm.spark, data.bucketSeconds)} id={`${base}-${index}`} /> : <span className="net-spark-empty">Sem tráfego</span>}
            <span className="net-spark-value"><strong>{formatBytes(volume)}</strong><small>pico {formatBits(farm.peakBps)}</small></span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------- VLANs

function VlanBars({ data }: { data: Panel['vlans'] }) {
  const [tip, setTip] = useState<Tip>(null);
  const host = useRef<HTMLDivElement>(null);
  if (!data.length) return <EmptyState title="Nenhuma VLAN no catálogo">O coletor lê as redes do console UniFi a cada captura.</EmptyState>;
  const scale = niceCeiling(Math.max(1, ...data.map((vlan) => vlan.nativePorts + vlan.taggedPorts)));
  const label = (vlan: Panel['vlans'][number]) => `${vlan.vlanId === null ? 'Sem VLAN' : `VLAN ${vlan.vlanId}`} · ${vlan.name}`;
  function show(target: HTMLElement, vlan: Panel['vlans'][number]) {
    const box = host.current?.getBoundingClientRect();
    const own = target.getBoundingClientRect();
    if (!box) return;
    setTip({ x: Math.min(box.width - 200, Math.max(0, own.left - box.left + own.width / 2 - 100)), y: own.top - box.top - 8, title: label(vlan), rows: [
      { label: 'portas com VLAN nativa', value: formatCount(vlan.nativePorts), swatch: 'net-key-rx' },
      { label: 'portas marcadas (tagged)', value: formatCount(vlan.taggedPorts), swatch: 'net-key-tx' },
      { label: vlan.farms === 1 ? 'fazenda' : 'fazendas', value: formatCount(vlan.farms) },
    ] });
  }
  return (
    <div className="viz-plot" ref={host} onPointerLeave={() => setTip(null)}>
      <div className="viz-hbars">
        {data.map((vlan) => {
          const total = vlan.nativePorts + vlan.taggedPorts;
          return (
            <div className="viz-hbar-row" key={`${vlan.vlanId}-${vlan.name}`}>
              <span className="viz-hbar-label" title={label(vlan)}>{label(vlan)}{!vlan.enabled && <small className="net-off"> desativada</small>}</span>
              <div className="viz-hbar-track" tabIndex={0} onPointerMove={(event) => show(event.currentTarget, vlan)} onFocus={(event) => show(event.currentTarget, vlan)} onBlur={() => setTip(null)}
                aria-label={`${label(vlan)}${vlan.enabled ? '' : ', desativada'}: ${vlan.nativePorts} portas nativas, ${vlan.taggedPorts} marcadas, em ${vlan.farms} ${vlan.farms === 1 ? 'fazenda' : 'fazendas'}`}>
                <div className="viz-hbar-area">
                  <div className="viz-hbar" style={{ width: `${Math.max(0.5, (total / scale) * 100)}%` }}>
                    {vlan.nativePorts > 0 && <span className="viz-seg net-seg-rx" style={{ flexGrow: vlan.nativePorts }} />}
                    {vlan.taggedPorts > 0 && <span className="viz-seg net-seg-tx" style={{ flexGrow: vlan.taggedPorts }} />}
                  </div>
                </div>
                <span className="viz-hbar-value">{formatCount(total)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------- utilização por switch

function portText(port: HeatPort) {
  const state = port.state === 'UP' ? 'com enlace' : port.state === 'DOWN' ? 'sem enlace' : 'estado desconhecido';
  const speed = port.speedMbps ? `, ${formatBits(port.speedMbps * 1e6)}` : '';
  const usage = port.utilization === null ? (port.state === 'UP' ? ', utilização não medida' : '') : `, ${formatPercent(port.utilization)} de utilização`;
  return `Porta ${port.idx} ${state}${speed}${usage}${port.poe ? ', PoE ativo' : ''}`;
}

function heatClass(port: HeatPort) {
  if (port.state !== 'UP') return 'heat-down';
  const level = heatLevel(port.utilization);
  return level === null ? 'heat-none' : `heat-${level}`;
}

function HeatStrip({ item }: { item: PanelSwitch }) {
  const [active, setActive] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  const host = useRef<HTMLDivElement>(null);
  const cells = useRef<Array<HTMLSpanElement | null>>([]);
  function show(index: number) {
    const port = item.ports[index];
    const cell = cells.current[index];
    const box = host.current?.getBoundingClientRect();
    if (!port || !cell || !box) return;
    const own = cell.getBoundingClientRect();
    setActive(index);
    setTip({ x: Math.min(box.width - 200, Math.max(0, own.left - box.left + own.width / 2 - 100)), y: own.top - box.top - 6,
      title: `${item.name} · Porta ${port.idx}`, rows: [
        { label: 'estado', value: port.state === 'UP' ? 'Com enlace' : port.state === 'DOWN' ? 'Sem enlace' : 'Desconhecido' },
        { label: 'velocidade', value: port.speedMbps ? formatBits(port.speedMbps * 1e6) : '—' },
        { label: 'utilização', value: port.utilization === null ? 'não medida' : formatPercent(port.utilization) },
        ...(port.poe ? [{ label: 'PoE', value: 'ativo' }] : []),
      ] });
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const start = active ?? 0;
    const last = item.ports.length - 1;
    show(event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.min(last, Math.max(0, start + (event.key === 'ArrowRight' ? 1 : -1))));
  }
  const clear = () => { setActive(null); setTip(null); };
  const up = item.ports.filter((port) => port.state === 'UP').length;
  const current = active === null ? null : item.ports[active];
  return (
    <div className="net-heat-row" ref={host} onPointerLeave={clear}>
      <span className="net-heat-name"><strong>{item.name}</strong><small>{item.farmName} · {up}/{item.ports.length} com enlace{item.status === 'offline' ? ' · offline' : ''}</small></span>
      <div className="net-heat-strip" tabIndex={0} role="group" aria-label={`${item.name}, ${item.farmName}: ${item.ports.length} portas, ${up} com enlace`}
        aria-describedby="net-heat-hint" onKeyDown={onKey} onFocus={() => show(active ?? 0)} onBlur={clear}>
        {item.ports.map((port, index) => (
          <span key={port.idx} ref={(node) => { cells.current[index] = node; }} className={`net-heat-cell ${heatClass(port)}`} data-active={active === index || undefined}
            data-poe={port.poe || undefined} onPointerMove={() => show(index)} />
        ))}
      </div>
      <p className="visually-hidden" aria-live="polite">{current ? portText(current) : ''}</p>
      <Tooltip tip={tip} />
    </div>
  );
}

function HeatStrips({ data }: { data: Panel }) {
  if (!data.switches.length) return <EmptyState title="Nenhum switch com portas lidas">As portas aparecem depois da primeira captura com detalhe dos dispositivos.</EmptyState>;
  return (
    <div className="net-heat">
      {data.switches.map((item) => <HeatStrip key={item.assetId} item={item} />)}
      <p id="net-heat-hint" className="visually-hidden">Use as setas para percorrer as portas do switch.</p>
      {data.switchesTruncated && <p className="cell-detail">Mostrando os primeiros {data.switches.length} switches. Filtre por fazenda para ver os demais.</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- tela

export function NetworkPanel({ farmId, online }: { farmId: string; online: boolean }) {
  const [period, setPeriod] = useState<TrafficPeriod>('24h');
  const [data, setData] = useState<Panel | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const trafficId = useId();

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ period });
    if (farmId !== 'all') params.set('farmId', farmId);
    queueMicrotask(() => setLoading(true));
    requestJson<Panel>(`/api/network/panel?${params}`, { signal: controller.signal })
      .then((result) => { setData(result); setError(''); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Não foi possível carregar o painel de rede.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period, farmId, online]);

  const periodLabel = PERIODS.find((item) => item.value === period)!.label.toLowerCase();
  const empty = data && !data.kpis.ports.total && !data.traffic.length && !data.kpis.devices.total && !data.kpis.vlans.total;
  return (
    <div className="content-stack net-panel">
      <div className="indicator-toolbar">
        <label className="filter-field">Período
          <select value={period} onChange={(event) => setPeriod(event.target.value as TrafficPeriod)}>
            {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <p className="cell-detail">{farmId === 'all' ? 'Todas as fazendas do seu escopo.' : 'Filtrado pela fazenda selecionada.'} Taxas em bits por segundo; volumes estimados em bytes. Horários de Cuiabá.</p>
        {data?.synthetic && <span className="demo-label"><FlaskConical size={15} aria-hidden="true" /> Dados de rede fictícios</span>}
      </div>
      {error && <p className="message warning" role="status">{error}{data ? ' Exibindo o último carregamento.' : ''}</p>}
      {!data ? (loading ? <p className="cell-detail" role="status">Carregando painel de rede…</p> : null) : empty ? (
        <EmptyState title="Nenhum dado de rede neste escopo">Ative um coletor UniFi em Integrações. Portas, VLANs e tráfego aparecem depois da primeira captura.</EmptyState>
      ) : (
        <div className="net-stack" data-loading={loading || undefined} aria-busy={loading}>
          <Kpis kpis={data.kpis} />
          <div className="viz-grid">
            <div className="net-wide">
              <ChartCard id={trafficId} title="Tráfego recebido e enviado" description={`Soma dos uplinks dos dispositivos raiz, ${periodLabel}, média por intervalo de ${data.bucketSeconds >= 3600 ? `${data.bucketSeconds / 3600} h` : `${data.bucketSeconds / 60} min`}.`}
                legend={<>
                  <LegendItem swatch="net-seg-rx" label="Recebido (RX)" icon={ArrowDownToLine} />
                  <LegendItem swatch="net-seg-tx" label="Enviado (TX)" icon={ArrowUpFromLine} />
                </>}
                table={(
                  <table>
                    <thead><tr><th scope="col">Início do intervalo</th><th scope="col">Recebido</th><th scope="col">Enviado</th><th scope="col">Pico RX</th><th scope="col">Volume</th></tr></thead>
                    <tbody>{[...data.traffic].reverse().map((point) => (
                      <tr key={point.t}><th scope="row">{fullLabel.format(new Date(point.t))}</th><td className="technical">{formatBits(point.rxBps)}</td>
                        <td className="technical">{formatBits(point.txBps)}</td><td className="technical">{formatBits(point.rxMaxBps)}</td>
                        <td className="technical">{formatBytes(point.rxBytes + point.txBytes)}</td></tr>
                    ))}</tbody>
                  </table>
                )}>
                <TrafficArea data={data} labelId={trafficId} />
              </ChartCard>
            </div>

            <ChartCard id="net-farms" title="Tráfego por fazenda" description="Volume no período e forma da curva. Mesma escala para todas as fazendas."
              table={(
                <table>
                  <thead><tr><th scope="col">Fazenda</th><th scope="col">Recebido</th><th scope="col">Enviado</th><th scope="col">Pico</th></tr></thead>
                  <tbody>{data.farms.map((farm) => (
                    <tr key={farm.farmId}><th scope="row">{farm.name}</th><td className="technical">{formatBytes(farm.rxBytes)}</td>
                      <td className="technical">{formatBytes(farm.txBytes)}</td><td className="technical">{formatBits(farm.peakBps)}</td></tr>
                  ))}</tbody>
                </table>
              )}>
              <FarmSparklines data={data} />
            </ChartCard>

            <ChartCard id="net-top-devices" title="Dispositivos com mais tráfego" description="Volume de uplink no período (recebido + enviado)."
              table={(
                <table>
                  <thead><tr><th scope="col">Dispositivo</th><th scope="col">Fazenda</th><th scope="col">Recebido</th><th scope="col">Enviado</th><th scope="col">Pico</th></tr></thead>
                  <tbody>{data.topDevices.map((item) => (
                    <tr key={item.assetId}><th scope="row">{item.name}</th><td>{item.farmName}</td><td className="technical">{formatBytes(item.rxBytes)}</td>
                      <td className="technical">{formatBytes(item.txBytes)}</td><td className="technical">{formatBits(item.peakBps)}</td></tr>
                  ))}</tbody>
                </table>
              )}>
              <SingleBars axis={(value) => formatBytes(value)} empty={<EmptyState title="Sem tráfego no período">Os dispositivos aparecem quando houver taxa de uplink.</EmptyState>}
                rows={data.topDevices.map((item) => ({ key: item.assetId, label: item.name, value: item.rxBytes + item.txBytes, display: formatBytes(item.rxBytes + item.txBytes),
                  detail: `${ROLE_LABEL[item.role]} · ${item.farmName} · pico ${formatBits(item.peakBps)}` }))} />
            </ChartCard>

            <ChartCard id="net-top-ports" title="Portas com mais tráfego agora" description="Última taxa derivada dos contadores por porta (recebido + enviado)."
              table={(
                <table>
                  <thead><tr><th scope="col">Porta</th><th scope="col">Fazenda</th><th scope="col">Recebido</th><th scope="col">Enviado</th><th scope="col">Utilização</th></tr></thead>
                  <tbody>{data.topPorts.map((port) => (
                    <tr key={`${port.assetId}-${port.idx}`}><th scope="row">{port.device} · porta {port.idx}</th><td>{port.farmName}</td><td className="technical">{formatBits(port.rxBps)}</td>
                      <td className="technical">{formatBits(port.txBps)}</td><td className="technical">{port.utilization === null ? '—' : formatPercent(port.utilization)}</td></tr>
                  ))}</tbody>
                </table>
              )}>
              <SingleBars axis={(value) => formatBits(value)} empty={<EmptyState title="Sem taxa por porta">A fonte atual não expõe contadores por porta; o tráfego vem do uplink de cada dispositivo.</EmptyState>}
                rows={data.topPorts.map((port) => ({ key: `${port.assetId}-${port.idx}`, label: `Porta ${port.idx} · ${port.device}`, value: port.rxBps + port.txBps,
                  display: formatBits(port.rxBps + port.txBps), detail: `${port.farmName}${port.utilization === null ? '' : ` · ${formatPercent(port.utilization)} de utilização`}` }))} />
            </ChartCard>

            <ChartCard id="net-vlans" title="Distribuição de VLANs" description="Portas por VLAN, somando as fazendas. VLANs sem portas informadas aparecem com zero."
              legend={<>
                <LegendItem swatch="net-seg-rx" label="Nativa" />
                <LegendItem swatch="net-seg-tx" label="Marcada (tagged)" />
              </>}
              table={(
                <table>
                  <thead><tr><th scope="col">VLAN</th><th scope="col">Nome</th><th scope="col">Fazendas</th><th scope="col">Nativa</th><th scope="col">Marcada</th><th scope="col">Situação</th></tr></thead>
                  <tbody>{data.vlans.map((vlan) => (
                    <tr key={`${vlan.vlanId}-${vlan.name}`}><th scope="row" className="technical">{vlan.vlanId ?? '—'}</th><td>{vlan.name}</td><td className="technical">{formatCount(vlan.farms)}</td>
                      <td className="technical">{formatCount(vlan.nativePorts)}</td><td className="technical">{formatCount(vlan.taggedPorts)}</td><td>{vlan.enabled ? 'Ativa' : 'Desativada'}</td></tr>
                  ))}</tbody>
                </table>
              )}>
              <VlanBars data={data.vlans} />
            </ChartCard>

            <div className="net-wide">
              <ChartCard id="net-heat" title="Utilização das portas por switch" description="Uma célula por porta, na ordem física. Cor mais intensa = maior utilização do sentido mais carregado."
                legend={<>
                  {HEAT_LEVELS.map((label, level) => <LegendItem key={label} swatch={`heat-${level}`} label={label} />)}
                  <LegendItem swatch="heat-none" label="Com enlace, sem medição" />
                  <LegendItem swatch="heat-down" label="Sem enlace" />
                  <LegendItem swatch="heat-poe" label="PoE ativo (traço inferior)" />
                </>}
                table={(
                  <table>
                    <thead><tr><th scope="col">Switch</th><th scope="col">Porta</th><th scope="col">Estado</th><th scope="col">Velocidade</th><th scope="col">Utilização</th><th scope="col">PoE</th></tr></thead>
                    <tbody>{data.switches.flatMap((item) => item.ports.map((port) => (
                      <tr key={`${item.assetId}-${port.idx}`}><th scope="row">{item.name} <small className="cell-detail">{item.farmName}</small></th><td className="technical">{port.idx}</td>
                        <td>{port.state === 'UP' ? 'Com enlace' : port.state === 'DOWN' ? 'Sem enlace' : 'Desconhecido'}</td>
                        <td className="technical">{port.speedMbps ? formatBits(port.speedMbps * 1e6) : '—'}</td>
                        <td className="technical">{port.utilization === null ? '—' : formatPercent(port.utilization)}</td><td>{port.poe ? 'Ativo' : '—'}</td></tr>
                    )))}</tbody>
                  </table>
                )}>
                <HeatStrips data={data} />
              </ChartCard>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
