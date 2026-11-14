import { CircleCheck, CircleHelp, CircleMinus, CircleX, Radio, Router } from 'lucide-react';
import type { DashboardAsset, DashboardFarm } from '../../server/dashboard';

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
} satisfies Record<DashboardAsset['status'], BadgeProps>;

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

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <Router size={24} aria-hidden="true" />
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}
