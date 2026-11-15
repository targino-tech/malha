'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, Box, ChevronDown, Plug, Settings, CloudUpload, FlaskConical, LayoutDashboard, LogOut, MapPin, Network, RefreshCw, WifiOff } from 'lucide-react';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import type { DashboardData } from '../../server/dashboard';
import { Administration } from './administration';
import { ImportFlow } from './import-flow';
import { Integrations } from './integrations';
import { Inventory } from './inventory';
import { Occurrences } from './occurrences';
import { Overview } from './overview';
import { formatDate } from './presentation';

const views = {
  overview: { label: 'Visão geral', title: 'Visão geral das fazendas', description: 'Acompanhe a comunicação com as unidades e a saúde dos ativos de rede.', icon: LayoutDashboard },
  occurrences: { label: 'Ocorrências', title: 'Ocorrências', description: 'Investigue e reconheça os alertas de comunicação, coleta e ativos.', icon: BellRing },
  inventory: { label: 'Inventário', title: 'Inventário de ativos', description: 'Identifique equipamentos, origem do cadastro e estado da última observação.', icon: Box },
  imports: { label: 'Importações', title: 'Importações de inventário', description: 'Inclua ativos de campo a partir da planilha da fazenda.', icon: CloudUpload },
  integrations: { label: 'Integrações', title: 'Integrações', description: 'Ative o coletor de cada fazenda e confirme a primeira coleta UniFi.', icon: Plug },
  admin: { label: 'Administração', title: 'Administração do grupo', description: 'Cadastre fazendas e defina quem acessa o Malha e com qual papel.', icon: Settings },
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
  const [view, setView] = useState<View>('overview');
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
    if (id === 'imports') return data.can['inventory.write'];
    if (id === 'integrations') return data.can['integrations.read'];
    if (id === 'admin') return data.can['members.manage'];
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
            <span className="brand-icon"><Network size={23} aria-hidden="true" /></span>
            <span><strong>malha<span className="brand-dot">.</span></strong><small>Operações de campo</small></span>
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
                {view !== 'imports' && view !== 'admin' && (
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
              {view === 'overview' && <Overview farms={farms} openOccurrences={data.occurrences.filter((item) => !item.resolvedAt && farms.some((farm) => farm.id === item.farmId))} generatedAt={data.generatedAt} onOpenFarm={(id) => { setFarmId(id); setView('inventory'); }} onOpenInventory={() => setView('inventory')} onOpenOccurrences={() => setView('occurrences')} />}
              {view === 'occurrences' && <Occurrences occurrences={data.occurrences} farms={farms} canAcknowledge={data.can['occurrences.acknowledge']} online={online} onChanged={() => { void refresh(true); }} />}
              {view === 'inventory' && <Inventory key={currentFarm} farms={data.farms} locations={data.locations} farmId={currentFarm} canEdit={data.can['inventory.write']} online={online} onChanged={() => { void refresh(true); }} />}
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
