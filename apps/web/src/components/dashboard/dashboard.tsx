'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BellRing, Box, ChartColumn, ChartPie, ChevronDown, GitMerge, Plug, ScrollText, Settings, CloudUpload, FlaskConical, LayoutDashboard, LogOut, MapPin, RefreshCw, WifiOff } from 'lucide-react';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import type { DashboardData } from '../../server/dashboard';
import { Administration } from './administration';
import { Audit } from './audit';
import { ChartsView } from './charts';
import { NetworkPanel } from './network-panel';
import { Indicators } from './indicators';
import { Reconciliation } from './reconciliation';
import { ImportFlow } from './import-flow';
import { Integrations } from './integrations';
import { Monitoring } from './monitoring';
import { Inventory } from './inventory';
import { Occurrences } from './occurrences';
import { Overview } from './overview';
import { formatDate } from './presentation';
import { BrandMark } from '../../app/site/_components/brand';

const views = {
  overview: { label: 'Visão geral', title: 'Visão geral das fazendas', description: 'Acompanhe a comunicação com as unidades e a saúde dos ativos de rede.', icon: LayoutDashboard },
  charts: { label: 'Painéis', title: 'Painéis da operação', description: 'Estado dos ativos, ocorrências por dia, disponibilidade dos coletores, inventário por categoria e tráfego da rede.', icon: ChartPie },
  occurrences: { label: 'Ocorrências', title: 'Ocorrências', description: 'Investigue e reconheça os alertas de comunicação, coleta e ativos.', icon: BellRing },
  indicators: { label: 'Indicadores', title: 'Indicadores de valor', description: 'Cobertura, inventário conferido, tempos de resposta e economia medida no piloto.', icon: ChartColumn },
  inventory: { label: 'Inventário', title: 'Inventário de ativos', description: 'Identifique equipamentos, origem do cadastro e estado da última observação.', icon: Box },
  reconciliation: { label: 'Conciliação', title: 'Conciliação do inventário', description: 'Confirme descobertas da coleta, vínculos automáticos e o cadastro de referência.', icon: GitMerge },
  imports: { label: 'Importações', title: 'Importações de inventário', description: 'Inclua ativos de campo a partir da planilha da fazenda.', icon: CloudUpload },
  integrations: { label: 'Integrações', title: 'Integrações', description: 'Ative o coletor de cada fazenda e confirme a primeira coleta UniFi.', icon: Plug },
  monitoring: { label: 'Monitoramento', title: 'Monitoramento externo', description: 'Monte o Zabbix e os painéis do Grafana a partir do inventário, por família de ativos.', icon: Activity },
  admin: { label: 'Administração', title: 'Administração do grupo', description: 'Cadastre fazendas e defina quem acessa o Malha e com qual papel.', icon: Settings },
  audit: { label: 'Auditoria', title: 'Auditoria', description: 'Quem fez o quê, quando e em qual escopo.', icon: ScrollText },
};

type View = keyof typeof views;

function ViewContent({ children, current }: { children: React.ReactNode; current: View }) {
  const reduced = useReducedMotion();
  return (
    <motion.div key={current} initial={reduced || current === 'overview' ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
      {children}
    </motion.div>
  );
}

export function Dashboard({ initialData }: { initialData: DashboardData }) {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>(initialData.role === 'diretoria' || initialData.role === 'auditor' ? 'indicators' : 'overview');
  const [farmId, setFarmId] = useState('all');
  const [online, setOnline] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const pendingRefresh = useRef<AbortController | null>(null);

  const refresh = useCallback(async (replacePending = false) => {
    if (!navigator.onLine || (pendingRefresh.current && !replacePending)) return;
    pendingRefresh.current?.abort();
    const controller = new AbortController();
    pendingRefresh.current = controller;
    setRefreshing(true);
    setRefreshError(false);
    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store', signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error('Falha ao atualizar');
      setData(await response.json() as DashboardData);
    } catch {
      if (!controller.signal.aborted) setRefreshError(true);
    } finally {
      if (pendingRefresh.current === controller) pendingRefresh.current = null;
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    function reconnect() {
      setOnline(true);
      void refresh();
    }
    function disconnect() { setOnline(false); }
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', disconnect);
    if (!navigator.onLine) disconnect();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 60_000);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', disconnect);
      window.clearInterval(interval);
      pendingRefresh.current?.abort();
      pendingRefresh.current = null;
    };
  }, [refresh]);

  function allowed(id: View) {
    if (id === 'imports' || id === 'reconciliation') return data.can['inventory.write'];
    if (id === 'audit') return data.can['audit.read'];
    if (id === 'integrations') return data.can['integrations.read'];
    if (id === 'admin') return data.can['members.manage'];
    if (id === 'monitoring') return data.can['monitoring.export'];
    return true;
  }
  const heading = views[view];
  const currentFarm = data.farms.some((farm) => farm.id === farmId) ? farmId : 'all';
  const farms = data.farms.filter((farm) => currentFarm === 'all' || farm.id === currentFarm);

  return (
    <MotionConfig reducedMotion="user">
      <div className="shell">
        <a className="skip-link" href="#main">Pular para o conteúdo</a>
        <aside className="sidebar">
          <button className="brand" type="button" onClick={() => { setView('overview'); setFarmId('all'); }} aria-label="Malha, visão geral">
            <span className="brand-icon"><BrandMark size={40} animated /></span>
            <span><strong>malha<span className="brand-dot" /></strong><small>Parque tecnológico do campo</small></span>
          </button>
          <nav className="navigation" aria-label="Navegação do painel">
            {(Object.entries(views) as Array<[View, (typeof views)[View]]>).filter(([id]) => allowed(id)).map(([id, item]) => (
              <button className="nav-link" type="button" key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
                <item.icon size={19} aria-hidden="true" /><span>{item.label}</span>
                {id === 'occurrences' && data.counts.openOccurrences > 0 && <span className="nav-count" aria-label={`${data.counts.openOccurrences} abertas`}>{data.counts.openOccurrences}</span>}
              </button>
            ))}
          </nav>
        </aside>

        <div className="workspace">
          <header className="topbar">
            <span className="breadcrumb"><span>Operação</span><ChevronDown size={14} aria-hidden="true" />{heading.label}</span>
            {data.demo && <span className="demo-label"><FlaskConical size={15} aria-hidden="true" /> Dados de demonstração</span>}
            {!data.demo && <form method="post" action="/api/auth/logout"><button className="button secondary" type="submit"><LogOut size={16} aria-hidden="true" /> Sair</button></form>}
          </header>
          <main id="main" className="main" tabIndex={-1}>
            <div className="page-heading">
              <div className="page-title"><h1>{heading.title}</h1><p>{heading.description}</p></div>
              <div className="page-actions">
                {view !== 'imports' && view !== 'admin' && view !== 'audit' && (
                  <label className="farm-select">
                    <MapPin size={17} aria-hidden="true" />
                    <select value={currentFarm} onChange={(event) => setFarmId(event.target.value)} aria-label="Filtrar por fazenda">
                      <option value="all">Todas as fazendas</option>
                      {data.farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
                    </select>
                  </label>
                )}
                <button className="button icon-button" type="button" onClick={() => { void refresh(); }} disabled={refreshing || !online} aria-label="Atualizar painel" title="Atualizar painel"><RefreshCw className={refreshing ? 'spin' : undefined} size={18} aria-hidden="true" /></button>
              </div>
            </div>
            <p className="as-of">Painel consultado em <time dateTime={data.generatedAt}>{formatDate(data.generatedAt)}</time> (horário de Cuiabá)</p>
            {(!online || refreshError) && (
              <p className="message warning" role="status"><WifiOff size={18} aria-hidden="true" />{!online ? 'Seu navegador está sem conexão.' : 'Falha ao atualizar o painel.'} Exibindo a última consulta.</p>
            )}
            <ViewContent current={view}>
              {view === 'overview' && <Overview farms={farms} farmId={currentFarm} openOccurrences={data.occurrences.filter((item) => !item.resolvedAt && farms.some((farm) => farm.id === item.farmId))} generatedAt={data.generatedAt} onOpenFarm={(id) => { setFarmId(id); setView('inventory'); }} onOpenInventory={() => setView('inventory')} onOpenOccurrences={() => setView('occurrences')} />}
              {view === 'occurrences' && <Occurrences occurrences={data.occurrences} farms={farms} canAcknowledge={data.can['occurrences.acknowledge']} online={online} onChanged={() => { void refresh(true); }} />}
              {view === 'inventory' && <Inventory key={currentFarm} farms={data.farms} locations={data.locations} farmId={currentFarm} canEdit={data.can['inventory.write']} canExport={data.can['exports.run']} online={online} onChanged={() => { void refresh(true); }} />}
              {view === 'charts' && <ChartsView farms={farms} farmId={currentFarm} online={online} network={<NetworkPanel farmId={currentFarm} online={online} />} />}
              {view === 'monitoring' && data.can['monitoring.export'] && <Monitoring farmId={currentFarm} online={online} canApply={data.can['monitoring.apply']} />}
              {view === 'indicators' && <Indicators farms={farms} farmId={currentFarm} canExport={data.can['exports.run']} canBaseline={data.can['baseline.manage']} online={online} />}
              {view === 'reconciliation' && (data.can['inventory.write']
                ? <Reconciliation key={currentFarm} farms={farms} canEdit={data.can['inventory.write']} online={online} onChanged={() => { void refresh(true); }} />
                : <p className="message warning" role="status">A permissão para conciliar o inventário foi alterada.</p>)}
              {view === 'audit' && (data.can['audit.read']
                ? <Audit farmNames={new Map(data.farms.map((farm) => [farm.id, farm.name]))} />
                : <p className="message warning" role="status">A permissão de auditoria foi alterada.</p>)}
              {view === 'integrations' && (data.can['integrations.read']
                ? <Integrations farms={farms} canEnroll={data.can['collectors.enroll']} online={online} onChanged={() => { void refresh(true); }} />
                : <p className="message warning" role="status">A permissão para ver integrações foi alterada.</p>)}
              {view === 'admin' && (data.can['members.manage']
                ? <Administration farms={data.farms} actor={data.actor} online={online} onChanged={() => { void refresh(true); }} />
                : <p className="message warning" role="status">A permissão de administração foi alterada.</p>)}
              {view === 'imports' && (data.can['inventory.write'] ? (
                <ImportFlow farms={data.farms} selectedFarm={currentFarm} online={online} onImported={() => { void refresh(true); }} />
              ) : <p className="message warning" role="status">A permissão para importar ativos foi alterada.</p>)}
            </ViewContent>
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}
