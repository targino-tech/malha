import { CircleCheck, CircleHelp, CircleMinus, CircleX, Radio, Router } from 'lucide-react';
import type { InventoryAsset } from '../../server/assets';
import type { DashboardFarm } from '../../server/dashboard';

export const wholeNumber = new Intl.NumberFormat('pt-BR');

const dataTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Cuiaba', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function formatDate(value: string | null): string {
  return value ? dataTime.format(new Date(value)) : '—';
}

export const collectorStatus = {
  online: { label: 'Em contato', icon: Radio, tone: 'healthy' },
  offline: { label: 'Sem contato', icon: CircleX, tone: 'critical' },
  missing: { label: 'Sem coletor', icon: CircleMinus, tone: 'neutral' },
} satisfies Record<DashboardFarm['collectorStatus'], BadgeProps>;

export const deviceStatus = {
  online: { label: 'Online', icon: CircleCheck, tone: 'healthy' },
  offline: { label: 'Offline', icon: CircleX, tone: 'critical' },
  unknown: { label: 'Indeterminado', icon: CircleHelp, tone: 'neutral' },
} satisfies Record<InventoryAsset['status'], BadgeProps>;

type BadgeProps = {
  label: string;
  icon: typeof Radio;
  tone: 'healthy' | 'critical' | 'neutral' | 'warning';
};

export function StatusBadge({ label, icon: Icon, tone }: BadgeProps) {
  return <span className={`status ${tone}`}><Icon size={14} aria-hidden="true" />{label}</span>;
}

export function hasFreshCapture(value: string | null, now: string): boolean {
  if (!value) return false;
  return new Date(now).getTime() - new Date(value).getTime() <= 15 * 60 * 1000;
}

const zoneNames: Record<string, string> = {
  'America/Cuiaba': 'Cuiabá', 'America/Campo_Grande': 'Campo Grande', 'America/Sao_Paulo': 'São Paulo',
  'America/Porto_Velho': 'Porto Velho', 'America/Manaus': 'Manaus', 'America/Bahia': 'Salvador', 'America/Belem': 'Belém',
};

export function timezoneLabel(zone: string) {
  return zoneNames[zone] ?? zone.split('/').at(-1)!.replaceAll('_', ' ');
}

export const sourceLabels: Record<InventoryAsset['source'], string> = { csv: 'CSV', unifi: 'UniFi', manual: 'Manual' };

/** Faz a requisição JSON e converte a resposta de erro do Malha em uma mensagem exibível. */
export async function requestJson<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...options } = init ?? {};
  const response = await fetch(url, {
    cache: 'no-store', ...options,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }),
  });
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'A solicitação não pôde ser concluída.');
  return payload as T;
}

/** Converte um instante ISO para o valor de um campo datetime-local no fuso da fazenda. */
export function toLocalInput(value: string | null, timeZone: string) {
  if (!value) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Interpreta o valor de um campo datetime-local no fuso da fazenda e devolve ISO em UTC. */
export function fromLocalInput(value: string, timeZone: string) {
  if (!value) return null;
  const guess = new Date(`${value}:00Z`);
  const shown = toLocalInput(guess.toISOString(), timeZone);
  const drift = new Date(`${shown}:00Z`).getTime() - guess.getTime();
  return new Date(guess.getTime() - drift).toISOString();
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <Router size={24} aria-hidden="true" />
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}
