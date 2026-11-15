'use client';

import { useEffect, useState } from 'react';
import { BellOff, BellRing, Mail, Pencil, Plus, RefreshCw, Send } from 'lucide-react';
import type { Channel, Delivery } from '../../server/alert-channels';
import type { DashboardFarm } from '../../server/dashboard';
import { EmptyState, formatDate, requestJson, StatusBadge } from './presentation';

// Rótulos locais: o módulo do servidor importa código de banco e não entra no bundle do navegador.
const RULES = ['collector_silent', 'capture_stale', 'asset_offline', 'asset_missing'] as const;
const ruleLabels: Record<(typeof RULES)[number], string> = {
  collector_silent: 'Coletor sem contato', capture_stale: 'Coleta UniFi desatualizada', asset_offline: 'Ativo offline', asset_missing: 'Divergência de inventário',
};
const kindLabels: Record<Channel['kind'], string> = { telegram: 'Telegram', email: 'E-mail' };
const eventLabels: Record<Delivery['event'], string> = { opened: 'Abertura', resolved: 'Encerramento', test: 'Teste' };
const statusBadges = {
  pending: { label: 'Na fila', icon: RefreshCw, tone: 'warning' },
  sent: { label: 'Enviada', icon: Send, tone: 'healthy' },
  suppressed: { label: 'Suprimida', icon: BellOff, tone: 'neutral' },
  skipped: { label: 'Descartada', icon: BellOff, tone: 'neutral' },
  failed: { label: 'Falhou', icon: BellOff, tone: 'critical' },
} as const;

function ChannelForm({ channel, farms, online, onSaved, onCancel }: {
  channel?: Channel; farms: DashboardFarm[]; online: boolean; onSaved: () => void; onCancel?: () => void;
}) {
  const [kind, setKind] = useState<Channel['kind']>(channel?.kind ?? 'telegram');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const prefix = channel ? `channel-${channel.id}` : 'channel-new';

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const farmIds = data.getAll('farmIds').map(String);
    const rules = data.getAll('rules').map(String);
    const body: Record<string, unknown> = {
      name: String(data.get('name') ?? '').trim(),
      farmIds: farmIds.length ? farmIds : null,
      rules: rules.length ? rules : null,
      minSeverity: data.get('minSeverity'),
      notifyResolved: data.get('notifyResolved') === 'on',
      rateLimitPerMinute: Number(data.get('rateLimitPerMinute')),
    };
    if (!channel) body.kind = kind;
    if (kind === 'telegram') {
      const token = String(data.get('botToken') ?? '').trim();
      if (token || !channel) body.botToken = token;
      body.chatId = String(data.get('chatId') ?? '').trim();
    } else {
      body.recipients = String(data.get('recipients') ?? '').split(/[\s,;]+/).filter(Boolean);
    }
    setBusy(true);
    setError('');
    try {
      await requestJson(channel ? `/api/alerts/channels/${channel.id}` : '/api/alerts/channels', { method: channel ? 'PATCH' : 'POST', json: body });
      if (!channel) { form.reset(); setKind('telegram'); }
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível salvar o canal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} aria-label={channel ? `Editar ${channel.name}` : 'Novo canal'}>
      {!channel && (
        <label className="form-field" htmlFor={`${prefix}-kind`}>Tipo
          <select id={`${prefix}-kind`} value={kind} onChange={(event) => setKind(event.target.value as Channel['kind'])}>
            <option value="telegram">Telegram</option>
            <option value="email">E-mail</option>
          </select>
        </label>
      )}
      <label className="form-field" htmlFor={`${prefix}-name`}>Nome do canal<input id={`${prefix}-name`} name="name" defaultValue={channel?.name} required maxLength={80} placeholder="Plantão de TI" /></label>
      {kind === 'telegram' ? (
        <>
          <label className="form-field" htmlFor={`${prefix}-token`}>Token do bot {channel && <small>(em branco mantém {channel.tokenHint})</small>}
            <input id={`${prefix}-token`} name="botToken" type="password" autoComplete="off" spellCheck={false} className="technical" required={!channel}
              placeholder="123456789:AA…" aria-describedby={`${prefix}-token-hint`} />
            <small id={`${prefix}-token-hint`}>Gerado pelo @BotFather. Fica cifrado e não volta para a tela.</small>
          </label>
          <label className="form-field" htmlFor={`${prefix}-chat`}>Chat ID<input id={`${prefix}-chat`} name="chatId" className="technical" required defaultValue={channel?.chatId ?? ''} placeholder="-1001234567890 ou @canal" /></label>
        </>
      ) : (
        <label className="form-field" htmlFor={`${prefix}-recipients`}>Destinatários <small>(separe por vírgula ou linha)</small>
          <textarea id={`${prefix}-recipients`} name="recipients" rows={2} required defaultValue={channel?.recipients?.join(', ') ?? ''} placeholder="ti@empresa.com.br" />
        </label>
      )}
      <label className="form-field" htmlFor={`${prefix}-severity`}>Severidade mínima
        <select id={`${prefix}-severity`} name="minSeverity" defaultValue={channel?.minSeverity ?? 'critical'}>
          <option value="critical">Só críticas</option>
          <option value="warning">Críticas e avisos</option>
        </select>
      </label>
      <label className="form-field" htmlFor={`${prefix}-rate`}>Mensagens por minuto<input id={`${prefix}-rate`} name="rateLimitPerMinute" type="number" min={1} max={120} defaultValue={channel?.rateLimitPerMinute ?? 20} /></label>
      <fieldset className="farm-checks">
        <legend>Fazendas (vazio = todas do grupo)</legend>
        {farms.map((farm) => (
          <label key={farm.id} className="check-field"><input type="checkbox" name="farmIds" value={farm.id} defaultChecked={channel?.farmIds?.includes(farm.id)} /> {farm.name}</label>
        ))}
      </fieldset>
      <fieldset className="farm-checks">
        <legend>Tipos de ocorrência (vazio = todos)</legend>
        {RULES.map((rule) => (
          <label key={rule} className="check-field"><input type="checkbox" name="rules" value={rule} defaultChecked={channel?.rules?.includes(rule)} /> {ruleLabels[rule]}</label>
        ))}
      </fieldset>
      <label className="check-field"><input type="checkbox" name="notifyResolved" defaultChecked={channel?.notifyResolved ?? true} /> Avisar também o encerramento</label>
      <div className="inline-actions">
        {onCancel && <button className="button secondary" type="button" onClick={onCancel}>Cancelar</button>}
        <button className="button primary" type="submit" disabled={!online || busy}>{channel ? 'Salvar canal' : <><Plus size={16} aria-hidden="true" /> Cadastrar canal</>}</button>
      </div>
      {error && <p className="message danger" role="alert">{error}</p>}
    </form>
  );
}

export function Alerts({ farms, online }: { farms: DashboardFarm[]; online: boolean }) {
  const [channels, setChannels] = useState<Channel[]>();
  const [deliveries, setDeliveries] = useState<Delivery[]>();
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [reload, setReload] = useState(0);
  const load = () => setReload((value) => value + 1);
  const farmNames = new Map(farms.map((farm) => [farm.id, farm.name]));

  useEffect(() => {
    let active = true;
    const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    Promise.all([requestJson<Channel[]>('/api/alerts/channels'), requestJson<Delivery[]>(`/api/alerts/deliveries${query}`)]).then(
      ([nextChannels, nextDeliveries]) => { if (active) { setChannels(nextChannels); setDeliveries(nextDeliveries); setError(''); } },
      (problem: unknown) => { if (active) setError(problem instanceof Error ? problem.message : 'Falha ao consultar os canais de alerta.'); },
    );
    return () => { active = false; };
  }, [reload, statusFilter]);

  async function act(channel: Channel, action: 'test' | 'toggle') {
    setBusy(channel.id);
    setError('');
    setNotice('');
    try {
      if (action === 'test') {
        await requestJson(`/api/alerts/channels/${channel.id}/test`, { method: 'POST' });
        setNotice(`Mensagem de teste enviada para ${channel.name}.`);
      } else {
        await requestJson(`/api/alerts/channels/${channel.id}`, { method: 'PATCH', json: { enabled: !channel.enabled } });
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'A operação não pôde ser concluída.');
    } finally {
      setBusy(undefined);
      load();
    }
  }

  const describe = (channel: Channel) => [
    kindLabels[channel.kind],
    channel.kind === 'telegram' ? `chat ${channel.chatId} · token ${channel.tokenHint}` : (channel.recipients ?? []).join(', '),
    channel.minSeverity === 'critical' ? 'só críticas' : 'críticas e avisos',
    channel.farmIds ? channel.farmIds.map((id) => farmNames.get(id) ?? 'Fazenda').join(', ') : 'todas as fazendas',
    channel.rules ? channel.rules.map((rule) => ruleLabels[rule]).join(', ') : 'todos os tipos',
    `${channel.rateLimitPerMinute}/min`,
  ].join(' · ');

  return (
    <div className="content-stack">
      <section className="panel" aria-labelledby="alert-channels-title">
        <div className="panel-heading">
          <div><h2 id="alert-channels-title"><BellRing size={18} aria-hidden="true" /> Canais de alerta</h2>
            <p>Telegram e e-mail por grupo, com filtro de fazenda, tipo e severidade. Manutenção e perda de contato do coletor suspendem alertas de ativos.</p></div>
          <button className="button icon-button" type="button" onClick={load} aria-label="Atualizar canais" title="Atualizar canais"><RefreshCw size={18} aria-hidden="true" /></button>
        </div>
        <div className="admin-body"><ChannelForm farms={farms} online={online} onSaved={load} /></div>
        {error && <p className="message danger occurrence-error" role="alert">{error}</p>}
        {notice && <p className="message success occurrence-error" role="status">{notice}</p>}
        {channels && !channels.length && <EmptyState title="Nenhum canal cadastrado">Cadastre um bot do Telegram ou uma lista de e-mails para receber as ocorrências.</EmptyState>}
        <ul className="admin-list" aria-label="Canais cadastrados">
          {channels?.map((channel) => (
            <li key={channel.id}>
              {editing === channel.id ? (
                <ChannelForm channel={channel} farms={farms} online={online} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); load(); }} />
              ) : (
                <div className="admin-row">
                  <div>
                    <strong>{channel.kind === 'email' ? <Mail size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />} {channel.name}</strong>
                    <span>{describe(channel)}</span>
                  </div>
                  <div className="inline-actions">
                    {!channel.enabled && <StatusBadge label="Desativado" icon={BellOff} tone="neutral" />}
                    <button className="button secondary" type="button" disabled={!online || busy === channel.id} onClick={() => { void act(channel, 'test'); }}>
                      <Send size={16} aria-hidden="true" /> Enviar teste
                    </button>
                    <button className="button secondary" type="button" disabled={!online || busy === channel.id} onClick={() => { void act(channel, 'toggle'); }}>
                      {channel.enabled ? 'Desativar' : 'Ativar'}
                    </button>
                    <button className="button icon-button" type="button" onClick={() => setEditing(channel.id)} aria-label={`Editar ${channel.name}`}><Pencil size={16} aria-hidden="true" /></button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="alert-deliveries-title">
        <div className="panel-heading">
          <div><h2 id="alert-deliveries-title">Histórico de entregas</h2><p>Últimas 100 mensagens por canal. Falhas temporárias voltam com espera crescente, até 5 tentativas.</p></div>
          <label className="filter-field" htmlFor="alert-delivery-status">Situação
            <select id="alert-delivery-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">Todas</option>
              {(Object.keys(statusBadges) as Array<keyof typeof statusBadges>).map((key) => <option key={key} value={key}>{statusBadges[key].label}</option>)}
            </select>
          </label>
        </div>
        {deliveries && !deliveries.length ? <EmptyState title="Nenhuma entrega">As mensagens enviadas pelos canais aparecem aqui.</EmptyState> : (
          <div className="table-container" role="region" tabIndex={0} aria-label="Tabela de entregas">
            <table aria-label="Entregas de alertas">
              <thead><tr><th scope="col">Criada em</th><th scope="col">Canal</th><th scope="col">Evento</th><th scope="col">Fazenda e ocorrência</th><th scope="col">Situação</th><th scope="col">Tentativas</th><th scope="col">Detalhe</th></tr></thead>
              <tbody>{deliveries?.map((item) => (
                <tr key={item.id}>
                  <td>{formatDate(item.createdAt)}</td>
                  <td>{item.channelName}<span className="cell-detail">{kindLabels[item.kind]}</span></td>
                  <td>{eventLabels[item.event]}</td>
                  <td>{item.farmName ?? '—'}{item.title && <span className="cell-detail">{item.title}</span>}</td>
                  <td><StatusBadge {...statusBadges[item.status]} /></td>
                  <td>{item.attempts}</td>
                  <td>{item.status === 'sent' ? `Enviada em ${formatDate(item.sentAt)}` : item.nextAttemptAt ? `Próxima tentativa ${formatDate(item.nextAttemptAt)}` : (item.lastError ?? '—')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
