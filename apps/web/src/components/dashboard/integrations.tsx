'use client';

import { useEffect, useState } from 'react';
import { CircleCheck, Clock, KeyRound, Plug, RefreshCw, ShieldOff } from 'lucide-react';
import type { IntegrationFarm } from '../../server/admin';
import type { DashboardFarm } from '../../server/dashboard';
import { EmptyState, formatDate, requestJson, StatusBadge, wholeNumber } from './presentation';

type Issued = { farmId: string; code: string; expiresAt: string };

function InstallSteps({ origin }: { origin: string }) {
  return (
    <ol className="install-steps">
      <li>Prepare um host Linux (amd64 ou arm64) na rede de gestão, com acesso de leitura à controladora UniFi e saída HTTPS para o Malha.</li>
      <li>Crie uma chave de Integrações na console UniFi e salve-a em um arquivo legível só pelo usuário do serviço.</li>
      <li>
        Salve o código de ativação em um arquivo protegido e ative o coletor:
        <pre className="technical"><code>{[
          `export MALHA_URL='${origin}'`,
          "export UNIFI_BASE_URL='https://<console>/proxy/network/integration/v1'",
          "export UNIFI_API_KEY_FILE='/etc/malha/unifi-api-key'",
          "export UNIFI_SITE_ID='<UUID do site>'",
          "export MALHA_DATA_DIR='/var/lib/malha'",
          "export MALHA_ENROLL_CODE_FILE='/etc/malha/codigo-ativacao'",
          './malha-collector enroll',
        ].join('\n')}</code></pre>
      </li>
      <li>Apague o arquivo do código, instale o serviço systemd e aguarde a primeira coleta aparecer nesta tela.</li>
    </ol>
  );
}

export function Integrations({ farms, canEnroll, online, onChanged }: {
  farms: DashboardFarm[]; canEnroll: boolean; online: boolean; onChanged: () => void;
}) {
  const [rows, setRows] = useState<IntegrationFarm[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [issued, setIssued] = useState<Issued>();
  const [reload, setReload] = useState(0);
  // A tela só é montada no navegador, depois da navegação pelo menu.
  const [origin] = useState(() => typeof window === 'undefined' ? 'https://<host-do-malha>' : window.location.origin);
  const load = () => setReload((value) => value + 1);

  useEffect(() => {
    let active = true;
    requestJson<IntegrationFarm[]>('/api/integrations').then(
      (next) => { if (active) { setRows(next); setError(''); } },
      (problem: unknown) => { if (active) setError(problem instanceof Error ? problem.message : 'Falha ao consultar as integrações.'); },
    );
    return () => { active = false; };
  }, [reload]);

  async function act(farmId: string, action: 'enrollment' | 'revoke') {
    setBusy(farmId);
    setError('');
    try {
      if (action === 'enrollment') {
        const result = await requestJson<{ code: string; expiresAt: string }>(`/api/farms/${farmId}/enrollment`, { method: 'POST' });
        setIssued({ farmId, ...result });
      } else {
        await requestJson(`/api/farms/${farmId}/revoke`, { method: 'POST' });
        setIssued(undefined);
      }
      load();
      onChanged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'A operação não pôde ser concluída.');
    } finally {
      setBusy(undefined);
    }
  }

  const visible = farms.map((farm) => ({ farm, integration: rows?.find((row) => row.farmId === farm.id) }));

  return (
    <div className="content-stack">
      <section className="panel" aria-labelledby="integrations-title">
        <div className="panel-heading">
          <div><h2 id="integrations-title">Coletores UniFi</h2><p>Um coletor por fazenda, somente leitura na controladora e com conexão iniciada pela fazenda.</p></div>
          <button className="button icon-button" type="button" onClick={load} aria-label="Atualizar integrações" title="Atualizar integrações"><RefreshCw size={18} aria-hidden="true" /></button>
        </div>
        {error && <p className="message danger occurrence-error" role="alert">{error}</p>}
        {!visible.length ? <EmptyState title="Nenhuma fazenda neste escopo">Cadastre fazendas na Administração.</EmptyState> : (
          <ul className="integration-list">
            {visible.map(({ farm, integration }) => {
              const state = !integration?.collectorId
                ? integration?.pendingCodeExpiresAt ? { label: 'Aguardando ativação', icon: Clock, tone: 'warning' as const }
                  : { label: 'Sem coletor', icon: Plug, tone: 'neutral' as const }
                : !integration.firstCaptureReceived ? { label: 'Aguardando primeira coleta', icon: Clock, tone: 'warning' as const }
                  : integration.online ? { label: 'Coletando', icon: CircleCheck, tone: 'healthy' as const }
                    : { label: 'Sem contato', icon: ShieldOff, tone: 'critical' as const };
              return (
                <li key={farm.id} className="integration-row">
                  <div className="integration-main">
                    <strong>{farm.name}</strong>
                    <span>{farm.location}</span>
                    <StatusBadge {...state} />
                  </div>
                  <dl className="integration-facts">
                    <div><dt>Versão</dt><dd className="technical">{integration?.version ?? '—'}</dd></div>
                    <div><dt>Fila local</dt><dd>{integration?.queueDepth == null ? '—' : wholeNumber.format(integration.queueDepth)}</dd></div>
                    <div><dt>Último sinal</dt><dd>{formatDate(integration?.lastHeartbeatAt ?? null)}</dd></div>
                    <div><dt>Última coleta</dt><dd>{formatDate(integration?.lastCaptureAt ?? null)}</dd></div>
                  </dl>
                  {canEnroll && (
                    <div className="integration-actions">
                      {integration?.collectorId ? (
                        <button className="button secondary" type="button" disabled={!online || busy === farm.id}
                          onClick={() => { if (window.confirm(`Revogar o coletor de ${farm.name}? Ele deixa de enviar dados na próxima requisição.`)) void act(farm.id, 'revoke'); }}>
                          <ShieldOff size={16} aria-hidden="true" /> Revogar coletor
                        </button>
                      ) : (
                        <button className="button primary" type="button" disabled={!online || busy === farm.id} onClick={() => { void act(farm.id, 'enrollment'); }}>
                          <KeyRound size={16} aria-hidden="true" /> {integration?.pendingCodeExpiresAt ? 'Gerar novo código' : 'Gerar código de ativação'}
                        </button>
                      )}
                    </div>
                  )}
                  {issued?.farmId === farm.id && (
                    <div className="enrollment-code">
                      <p className="install-note">Este código vale até {formatDate(issued.expiresAt)} e só é exibido agora. Siga os passos de instalação abaixo.</p>
                      <label className="form-field">Código de ativação de {farm.name}
                        <input className="technical" readOnly value={issued.code} onFocus={(event) => event.currentTarget.select()} />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="install-title">
        <div className="panel-heading"><div><h2 id="install-title">Instalação do coletor</h2><p>Passos para cada fazenda. O guia completo está em collector/README.md.</p></div></div>
        <div className="install-body"><InstallSteps origin={origin} /></div>
      </section>
    </div>
  );
}
