'use client';

import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import type { AuditEntry } from '../../server/exports';
import { EmptyState, formatDate, requestJson } from './presentation';

const actionLabels: Record<string, string> = {
  'asset.create': 'Ativo cadastrado', 'asset.update': 'Ativo alterado', 'asset.archive': 'Ativo arquivado', 'asset.restore': 'Ativo restaurado',
  'inventory.import': 'Importação de inventário', 'occurrence.acknowledge': 'Ocorrência reconhecida', 'service.record': 'Atendimento registrado',
  'baseline.save': 'Linha de base definida', 'farm.create': 'Fazenda cadastrada', 'farm.update': 'Fazenda alterada',
  'member.create': 'Membro adicionado', 'member.update': 'Membro alterado', 'member.deactivate': 'Membro desativado',
  'collector.enroll': 'Coletor ativado', 'collector.enrollment_code': 'Código de ativação gerado', 'collector.revoke': 'Coletor revogado',
  'reconciliation.confirm': 'Ativo conferido', 'reconciliation.merge': 'Descoberta vinculada', 'reconciliation.unlink': 'Vínculo desfeito',
  'export.assets': 'Inventário exportado', 'export.occurrences': 'Evidências exportadas', 'export.audit': 'Auditoria exportada',
  'alerts.recipient.add': 'Destinatário de alerta adicionado', 'alerts.recipient.remove': 'Destinatário de alerta removido',
  'alerts.channel.create': 'Canal de alerta cadastrado', 'alerts.channel.update': 'Canal de alerta alterado', 'alerts.channel.enable': 'Canal de alerta ativado',
  'alerts.channel.disable': 'Canal de alerta desativado', 'alerts.channel.test': 'Teste de canal de alerta',
};

type Page = { items: AuditEntry[]; nextCursor: string | null };

export function Audit({ farmNames }: { farmNames: Map<string, string> }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    requestJson<Page>(`/api/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`).then(
      (page) => { if (active) { setPages((previous) => cursor ? [...previous, page] : [page]); setLoading(false); } },
      (problem: unknown) => { if (active) { setError(problem instanceof Error ? problem.message : 'Falha ao consultar a auditoria.'); setLoading(false); } },
    );
    return () => { active = false; };
  }, [cursor]);

  const items = pages.flatMap((page) => page.items);
  const next = pages.at(-1)?.nextCursor ?? null;
  const scopeText = (scope: Record<string, unknown>) => {
    const farm = typeof scope.farmId === 'string' ? farmNames.get(scope.farmId) : undefined;
    const parts = [farm, typeof scope.count === 'number' ? `${scope.count} itens` : undefined, typeof scope.rows === 'number' ? `${scope.rows} linhas` : undefined,
      typeof scope.role === 'string' ? `papel ${scope.role}` : undefined];
    return parts.filter(Boolean).join(' · ');
  };

  return (
    <section className="panel" aria-labelledby="audit-title">
      <div className="panel-heading">
        <div><h2 id="audit-title">Trilha de auditoria</h2><p>Mutações e exportações por ator, ação e escopo. Retida por 365 dias.</p></div>
        <div className="inline-actions">
          <a className="button secondary" href="/api/exports/audit?days=90&format=xlsx" download><FileSpreadsheet size={16} aria-hidden="true" /> Planilha de 90 dias</a>
          <a className="button secondary" href="/api/exports/audit?days=90" download><Download size={16} aria-hidden="true" /> CSV</a>
        </div>
      </div>
      {error && <p className="message danger occurrence-error" role="alert">{error}</p>}
      {!items.length && !loading ? <EmptyState title="Nenhum registro">As ações no Malha aparecem aqui.</EmptyState> : (
        <ol className="admin-list" aria-label="Registros de auditoria">
          {items.map((entry) => (
            <li key={entry.id}><div className="admin-row"><div>
              <strong>{actionLabels[entry.action] ?? entry.action}</strong>
              <span>{formatDate(entry.occurredAt)} · {entry.actorName ?? (entry.actor === 'malha' || entry.actor === 'cli' || entry.actor === 'demo' ? entry.actor : <span className="technical">{entry.actor}</span>)}</span>
              {scopeText(entry.scope) && <span>{scopeText(entry.scope)}</span>}
            </div></div></li>
          ))}
        </ol>
      )}
      {next && (
        <div className="pagination">
          <button className="button secondary" type="button" disabled={loading} onClick={() => { setLoading(true); setCursor(next); }}>Carregar mais</button>
        </div>
      )}
    </section>
  );
}
