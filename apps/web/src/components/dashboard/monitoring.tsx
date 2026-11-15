'use client';

import { useEffect, useState } from 'react';
import { CloudUpload, Download, LayoutTemplate, Link2, ServerCog, Trash2 } from 'lucide-react';
import type { MonitoringPlan, Model } from '../../server/monitoring';
import type { FamilyId } from '../../server/catalog';
import { EmptyState, requestJson, wholeNumber } from './presentation';

type Plan = MonitoringPlan & { catalog: Array<{ family: FamilyId; label: string; base: string[]; malha: string[]; panels: string[] }> };

const MODELS: Array<{ id: Model; title: string; text: string }> = [
  { id: 'malha', title: 'Modelo Malha', text: 'Templates por família e fabricante (SNMP, agente) e painéis com tráfego, erros, CPU e memória.' },
  { id: 'base', title: 'Modelo base', text: 'Só disponibilidade, latência e perda por ICMP. Funciona em qualquer Zabbix, sem SNMP nem agente.' },
];

export function Monitoring({ farmId, online, canApply }: { farmId: string; online: boolean; canApply: boolean }) {
  const [model, setModel] = useState<Model>('malha');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const params = new URLSearchParams({ model });
  if (farmId !== 'all') params.set('farmId', farmId);
  const query = params.toString();

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    requestJson<Plan>(`/api/monitoring/plan?${query}`, { signal: controller.signal })
      .then((result) => { setPlan(result); setError(''); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Não foi possível montar a prévia.'); });
    return () => controller.abort();
  }, [query, online]);

  return (
    <div className="content-stack">
      <section className="panel" aria-labelledby="monitoring-model-title">
        <div className="panel-heading"><div><h2 id="monitoring-model-title"><LayoutTemplate size={18} aria-hidden="true" /> Modelo</h2>
          <p>O Malha monta o Zabbix e o Grafana a partir do inventário: um host por ativo com IP, agrupado por fazenda e por família.</p></div></div>
        <fieldset className="model-picker">
          <legend className="visually-hidden">Modelo de monitoramento</legend>
          {MODELS.map((option) => (
            <label key={option.id} data-checked={model === option.id}>
              <input type="radio" name="monitoring-model" value={option.id} checked={model === option.id} onChange={() => setModel(option.id)} />
              <strong>{option.title}</strong><span>{option.text}</span>
            </label>
          ))}
        </fieldset>
      </section>

      {error && <p className="message warning" role="status">{error}</p>}
      {plan && (
        <>
          <section className="panel" aria-labelledby="monitoring-preview-title">
            <div className="panel-heading">
              <div><h2 id="monitoring-preview-title"><ServerCog size={18} aria-hidden="true" /> Prévia</h2>
                <p>{wholeNumber.format(plan.hosts.length)} hosts para o Zabbix{plan.skipped.length ? `, ${plan.skipped.length} ativos fora por falta de IP` : ''}.</p></div>
              {plan.hosts.length > 0 && <a className="button primary" href={`/api/monitoring/zabbix?${query}`} download><Download size={16} aria-hidden="true" /> Baixar Zabbix (JSON)</a>}
            </div>
            {plan.hosts.length === 0 ? <EmptyState title="Nenhum ativo com IP">Cadastre o IP dos ativos no inventário para montar o monitoramento.</EmptyState> : (
              <div className="table-container" role="region" tabIndex={0} aria-label="Hosts que serão criados">
                <table>
                  <thead><tr><th scope="col">Família</th><th scope="col">Hosts</th><th scope="col">Templates do Zabbix</th><th scope="col">Painel do Grafana</th></tr></thead>
                  <tbody>{plan.families.map((family) => (
                    <tr key={family.family}>
                      <th scope="row">{family.label}</th>
                      <td className="technical">{wholeNumber.format(family.hosts)}</td>
                      <td>{[...new Set(plan.hosts.filter((host) => host.family === family.family).flatMap((host) => host.templates))].join(', ')}</td>
                      <td><a className="button secondary" href={`/api/monitoring/grafana?${query}&family=${family.family}`} download><Download size={15} aria-hidden="true" /> Painel</a></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          {canApply && <ApplyPanel query={query} online={online} />}

          <section className="panel" aria-labelledby="monitoring-catalog-title">
            <div className="panel-heading"><div><h2 id="monitoring-catalog-title">Catálogo de modelos</h2><p>O que cada família recebe. Templates oficiais do Zabbix 7.0 LTS.</p></div></div>
            <div className="table-container" role="region" tabIndex={0} aria-label="Catálogo de modelos">
              <table>
                <thead><tr><th scope="col">Família</th><th scope="col">Modelo base</th><th scope="col">Modelo Malha</th><th scope="col">Painéis</th></tr></thead>
                <tbody>{plan.catalog.map((entry) => (
                  <tr key={entry.family}><th scope="row">{entry.label}</th><td>{entry.base.join(', ')}</td><td>{entry.malha.join(', ')}</td><td>{entry.panels.join(', ')}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="panel" aria-labelledby="monitoring-steps-title">
            <div className="panel-heading"><div><h2 id="monitoring-steps-title">Como importar</h2><p>Os arquivos levam IPs da rede: guarde e compartilhe como dado interno.</p></div></div>
            <div className="install-body"><ol className="install-steps">
              <li><strong>Zabbix 7.0:</strong> em Coleta de dados → Hosts, use Importar e envie o JSON. Os templates listados precisam existir no servidor (já vêm na instalação padrão).</li>
              <li>Para SNMP, defina a macro <code className="technical">{'{$SNMP_COMMUNITY}'}</code> no grupo ou globalmente. Para Windows e Linux, instale o Zabbix agent nos ativos.</li>
              <li><strong>Grafana:</strong> instale o plugin Zabbix (alexanderzobnin-zabbix-app), crie a fonte de dados apontando para o seu Zabbix e importe cada painel em Dashboards → Importar.</li>
              <li>Reexportar mantém os mesmos ids de grupos e painéis: importar de novo atualiza em vez de duplicar.</li>
            </ol></div>
          </section>
        </>
      )}
    </div>
  );
}

type Connection = { kind: 'zabbix' | 'grafana'; url: string; updatedAt: string; lastResult: Record<string, unknown> | null };
const LABELS = { zabbix: 'Zabbix', grafana: 'Grafana' } as const;
const HINTS = {
  zabbix: 'URL do frontend (ex.: https://zabbix.grupo.local) e um token de API (Usuários → Tokens de API) com permissão para criar hosts.',
  grafana: 'URL do Grafana e um token de conta de serviço com papel Editor. O plugin Zabbix e a fonte de dados precisam existir.',
};

function describe(kind: Connection['kind'], result: Record<string, unknown>) {
  if (kind === 'zabbix') {
    const missing = Array.isArray(result.missingTemplates) ? result.missingTemplates as string[] : [];
    return `${result.hosts} hosts enviados${missing.length ? `; templates ausentes no servidor (ficaram só com ICMP): ${missing.join(', ')}` : ''}.`;
  }
  return `${result.dashboards} painéis publicados na pasta Malha, usando a fonte ${String(result.datasource)}.`;
}

function ApplyPanel({ query, online }: { query: string; online: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    requestJson<Connection[]>('/api/monitoring/connections', { signal: controller.signal }).then(setConnections).catch(() => undefined);
    return () => controller.abort();
  }, [online, reload]);

  async function save(event: React.FormEvent<HTMLFormElement>, kind: Connection['kind']) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(`save-${kind}`);
    setMessage(null);
    try {
      await requestJson('/api/monitoring/connections', { method: 'PUT', json: { kind, url: data.get('url'), token: data.get('token') } });
      form.reset();
      setMessage({ tone: 'success', text: `Conexão com o ${LABELS[kind]} salva. O token fica cifrado e não volta para a tela.` });
      setReload((value) => value + 1);
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Não foi possível salvar.' });
    } finally {
      setBusy(null);
    }
  }

  async function apply(kind: Connection['kind']) {
    setBusy(`apply-${kind}`);
    setMessage(null);
    try {
      const result = await requestJson<Record<string, unknown>>(`/api/monitoring/apply?${query}&target=${kind}`, { method: 'POST' });
      setMessage({ tone: 'success', text: `${LABELS[kind]}: ${describe(kind, result)}` });
      setReload((value) => value + 1);
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Não foi possível aplicar.' });
    } finally {
      setBusy(null);
    }
  }

  async function remove(kind: Connection['kind']) {
    setBusy(`remove-${kind}`);
    try {
      await requestJson(`/api/monitoring/connections?kind=${kind}`, { method: 'DELETE' });
      setReload((value) => value + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="monitoring-apply-title">
      <div className="panel-heading"><div><h2 id="monitoring-apply-title"><CloudUpload size={18} aria-hidden="true" /> Aplicar pela API</h2>
        <p>O Malha cria e atualiza hosts no Zabbix e publica os painéis no Grafana. O servidor do Malha precisa alcançar esses endereços.</p></div></div>
      {message && <p className={`message ${message.tone} occurrence-error`} role="status">{message.text}</p>}
      <ul className="admin-list">
        {(['zabbix', 'grafana'] as const).map((kind) => {
          const saved = connections.find((item) => item.kind === kind);
          return (
            <li key={kind}>
              <div className="admin-row">
                <div>
                  <strong><Link2 size={15} aria-hidden="true" /> {LABELS[kind]}</strong>
                  <span>{saved ? `${saved.url} · salvo em ${new Date(saved.updatedAt).toLocaleString('pt-BR')}` : 'Sem conexão cadastrada.'}</span>
                  {saved?.lastResult && <span>Última aplicação: {describe(kind, saved.lastResult)}</span>}
                </div>
                {saved && (
                  <div className="inline-actions">
                    <button type="button" className="button primary" disabled={!online || busy !== null} onClick={() => apply(kind)}>
                      <CloudUpload size={16} aria-hidden="true" /> {busy === `apply-${kind}` ? 'Aplicando…' : `Aplicar no ${LABELS[kind]}`}
                    </button>
                    <button type="button" className="button secondary icon-button" aria-label={`Remover conexão com o ${LABELS[kind]}`} disabled={busy !== null} onClick={() => remove(kind)}>
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
              <form className="inline-form" onSubmit={(event) => save(event, kind)} aria-label={`Conexão com o ${LABELS[kind]}`}>
                <label className="form-field">URL<input name="url" type="url" required placeholder={`https://${kind}.grupo.local`} defaultValue={saved?.url} /></label>
                <label className="form-field">Token<input name="token" type="password" required autoComplete="off" minLength={8} placeholder={saved ? 'Novo token para substituir' : 'Token de API'} /></label>
                <button type="submit" className="button secondary" disabled={!online || busy !== null}>{saved ? 'Atualizar conexão' : 'Salvar conexão'}</button>
              </form>
              <p className="cell-detail">{HINTS[kind]}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
