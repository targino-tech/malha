'use client';

import { useEffect, useState } from 'react';
import { CircleCheck, Link2, Unlink } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { ReconciliationQueue, ReviewItem } from '../../server/reconciliation';
import { deviceStatus, EmptyState, formatDate, requestJson, sourceLabels, StatusBadge, wholeNumber } from './presentation';

type Props = { farms: DashboardFarm[]; canEdit: boolean; online: boolean; onChanged: () => void };

type SectionProps = {
  id: string; title: string; description: string; items: ReviewItem[]; total: number;
  farmNames: Map<string, string>; render: (item: ReviewItem) => React.ReactNode;
};

function Section({ id, title, description, items, total, farmNames, render }: SectionProps) {
  const visible = items.filter((item) => farmNames.has(item.farmId));
  const describe = (item: ReviewItem) => [farmNames.get(item.farmId), item.model ?? item.category, item.mac, item.ip].filter(Boolean).join(' · ');
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-heading">
        <div><h2 id={id}>{title}</h2><p>{description}</p></div>
        <span className="count-label">{wholeNumber.format(total)} {total === 1 ? 'pendente' : 'pendentes'}</span>
      </div>
      {!visible.length ? <EmptyState title="Nada pendente">Esta fila está em dia.</EmptyState> : (
        <ul className="review-list" aria-label={title}>
          {visible.map((item) => (
            <li key={item.id} className="review-row">
              <div className="occurrence-main">
                <strong>{item.name}</strong>
                <span className="technical">{describe(item)}</span>
                <span>{sourceLabels[item.source]} · última observação {formatDate(item.lastObservedAt)}{item.incomplete ? ' · cadastro incompleto' : ''}</span>
              </div>
              <StatusBadge {...deviceStatus[item.status]} />
              <div className="occurrence-actions">{render(item)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Reconciliation({ farms, canEdit, online, onChanged }: Props) {
  const [queue, setQueue] = useState<ReconciliationQueue>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);
  const farmNames = new Map(farms.map((farm) => [farm.id, farm.name]));

  useEffect(() => {
    let active = true;
    requestJson<ReconciliationQueue>('/api/reconciliation').then(
      (next) => { if (active) { setQueue(next); setError(''); } },
      (problem: unknown) => { if (active) setError(problem instanceof Error ? problem.message : 'Falha ao consultar a conciliação.'); },
    );
    return () => { active = false; };
  }, [reload]);

  async function act(body: Record<string, string>) {
    setBusy(body.assetId);
    setError('');
    try {
      await requestJson('/api/reconciliation', { method: 'POST', json: body });
      setReload((value) => value + 1);
      onChanged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'A operação não pôde ser concluída.');
    } finally {
      setBusy(undefined);
    }
  }

  const disabled = (item: ReviewItem) => !online || !canEdit || busy === item.id;

  if (!queue) return error ? <p className="message danger" role="alert">{error}</p> : <p className="empty-state" role="status">Consultando conciliação…</p>;
  const referenceOptions = (farmId: string) => queue.reference.filter((item) => item.farmId === farmId);

  return (
    <div className="content-stack">
      <ul className="metrics" aria-label="Situação da conciliação">
        {[
          { title: 'Descobertos pendentes', value: queue.counts.discovered, note: 'Coletados sem cadastro conferido' },
          { title: 'Vínculos a confirmar', value: queue.counts.links, note: 'Ligados por MAC automaticamente' },
          { title: 'Cadastro a conferir', value: queue.counts.reference, note: 'Itens da lista de referência' },
          { title: 'Cadastro incompleto', value: queue.counts.incomplete, note: 'Sem etiqueta ou local técnico' },
        ].map((card) => (
          <li className={`metric ${card.value ? 'amber' : 'normal'}`} key={card.title}>
            <div className="metric-top"><span>{card.title}</span></div>
            <strong>{wholeNumber.format(card.value)}</strong>
            <p>{card.note}</p>
          </li>
        ))}
      </ul>
      {error && <p className="message danger" role="alert">{error}</p>}

      <Section farmNames={farmNames} id="discovered-title" title="Descobertos pela coleta" total={queue.counts.discovered} items={queue.discovered}
        description="Vincule ao item do cadastro correspondente ou confirme como um novo ativo."
        render={(item) => {
          const options = referenceOptions(item.farmId);
          return <>
            {options.length > 0 && (
              <label className="filter-field">Vincular a
                <select value={targets[item.id] ?? ''} onChange={(event) => setTargets({ ...targets, [item.id]: event.target.value })} aria-label={`Item do cadastro para ${item.name}`}>
                  <option value="">Escolha um item</option>
                  {options.map((option) => <option key={option.id} value={option.id}>{option.name}{option.tag ? ` (${option.tag})` : ''}</option>)}
                </select>
              </label>
            )}
            {targets[item.id] && (
              <button className="button primary" type="button" disabled={disabled(item)} onClick={() => { void act({ action: 'merge', assetId: item.id, targetId: targets[item.id] }); }}>
                <Link2 size={16} aria-hidden="true" /> Vincular
              </button>
            )}
            <button className="button secondary" type="button" disabled={disabled(item)} onClick={() => { void act({ action: 'confirm', assetId: item.id }); }}
              aria-label={`Confirmar ${item.name} como novo ativo`}>
              <CircleCheck size={16} aria-hidden="true" /> Novo ativo
            </button>
          </>;
        }} />

      <Section farmNames={farmNames} id="links-title" title="Vínculos automáticos" total={queue.counts.links} items={queue.links}
        description="O Malha ligou o cadastro ao dispositivo pelo MAC. Confirme ou desfaça o vínculo."
        render={(item) => <>
          <button className="button secondary" type="button" disabled={disabled(item)} onClick={() => { void act({ action: 'unlink', assetId: item.id }); }}
            aria-label={`Desfazer vínculo de ${item.name}`}><Unlink size={16} aria-hidden="true" /> Desfazer</button>
          <button className="button primary" type="button" disabled={disabled(item)} onClick={() => { void act({ action: 'confirm', assetId: item.id }); }}
            aria-label={`Confirmar vínculo de ${item.name}`}><CircleCheck size={16} aria-hidden="true" /> Confirmar</button>
        </>} />

      <Section farmNames={farmNames} id="reference-title" title="Cadastro a conferir" total={queue.counts.reference} items={queue.reference}
        description="Confirme em campo os itens da lista de referência. Eles contam no indicador de inventário conferido."
        render={(item) => (
          <button className="button primary" type="button" disabled={disabled(item)} onClick={() => { void act({ action: 'confirm', assetId: item.id }); }}
            aria-label={`Conferir ${item.name}`}><CircleCheck size={16} aria-hidden="true" /> Conferido</button>
        )} />
    </div>
  );
}
