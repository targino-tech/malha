'use client';

import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowRight, Box, Pencil, Plus, Search, Wrench, X } from 'lucide-react';
import type { InventoryAsset } from '../../server/assets';
import type { DashboardFarm, TechnicalLocation } from '../../server/dashboard';
import { deviceStatus, EmptyState, formatDate, fromLocalInput, requestJson, sourceLabels, StatusBadge, timezoneLabel, toLocalInput } from './presentation';

type Page = { items: InventoryAsset[]; total: number; nextCursor: string | null };

type InventoryProps = {
  farms: DashboardFarm[];
  locations: TechnicalLocation[];
  farmId: string;
  canEdit: boolean;
  online: boolean;
  onChanged: () => void;
};

function Modal({ title, labelId, onClose, children }: { title: string; labelId: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className="asset-dialog" aria-labelledby={labelId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="panel-heading">
        <div><h2 id={labelId}>{title}</h2></div>
        <button className="button icon-button" type="button" onClick={onClose} aria-label="Fechar"><X size={20} aria-hidden="true" /></button>
      </div>
      {children}
    </dialog>
  );
}

function AssetDetails({ asset, farm, canEdit, online, onEdit, onArchive, onClose }: {
  asset: InventoryAsset; farm?: DashboardFarm; canEdit: boolean; online: boolean;
  onEdit: () => void; onArchive: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openedAt] = useState(() => Date.now());
  const inMaintenance = asset.maintenanceUntil && Date.parse(asset.maintenanceUntil) > openedAt;
  return (
    <Modal title={asset.name} labelId="asset-title" onClose={onClose}>
      <div className="asset-details">
        <p className="cell-detail">{farm?.name ?? 'Fazenda'} · {asset.category}</p>
        <div className="asset-badges">
          <StatusBadge {...deviceStatus[asset.status]} />
          {inMaintenance && <StatusBadge label="Em manutenção" icon={Wrench} tone="warning" />}
          {asset.archivedAt && <StatusBadge label="Arquivado" icon={Archive} tone="neutral" />}
        </div>
        <dl>
          <div><dt>Etiqueta</dt><dd>{asset.tag ?? '—'}</dd></div>
          <div><dt>Origem</dt><dd>{sourceLabels[asset.source]}</dd></div>
          <div><dt>Local técnico</dt><dd>{asset.locationName ?? '—'}</dd></div>
          <div><dt>Responsável</dt><dd>{asset.owner ?? '—'}</dd></div>
          <div><dt>Endereço IP</dt><dd className="technical">{asset.ip ?? '—'}</dd></div>
          <div><dt>Endereço MAC</dt><dd className="technical">{asset.mac ?? '—'}</dd></div>
          <div><dt>Modelo</dt><dd>{asset.model ?? '—'}</dd></div>
          <div><dt>Firmware</dt><dd className="technical">{asset.firmware ?? '—'}</dd></div>
          <div><dt>Criticidade</dt><dd>{asset.critical ? 'Crítico' : 'Padrão'}</dd></div>
          <div><dt>Última observação</dt><dd>{formatDate(asset.lastObservedAt)}</dd></div>
          {inMaintenance && <div><dt>Manutenção até</dt><dd>{formatDate(asset.maintenanceUntil)}</dd></div>}
        </dl>
        {error && <p className="message danger" role="alert">{error}</p>}
        {canEdit && (
          <div className="dialog-actions">
            <button className="button secondary" type="button" disabled={!online || busy} onClick={async () => {
              setBusy(true);
              setError('');
              try { await onArchive(); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Falha ao arquivar.'); } finally { setBusy(false); }
            }}>
              {asset.archivedAt ? <><ArchiveRestore size={16} aria-hidden="true" /> Restaurar</> : <><Archive size={16} aria-hidden="true" /> Arquivar</>}
            </button>
            {!asset.archivedAt && <button className="button primary" type="button" disabled={!online} onClick={onEdit}><Pencil size={16} aria-hidden="true" /> Editar</button>}
          </div>
        )}
      </div>
    </Modal>
  );
}

const NEW_LOCATION = '__new__';

function AssetForm({ asset, farms, locations, defaultFarm, online, onSaved, onClose }: {
  asset?: InventoryAsset; farms: DashboardFarm[]; locations: TechnicalLocation[]; defaultFarm: string; online: boolean;
  onSaved: (asset: InventoryAsset) => void; onClose: () => void;
}) {
  const [farmId, setFarmId] = useState(asset?.farmId ?? (defaultFarm !== 'all' ? defaultFarm : farms[0]?.id ?? ''));
  const farm = farms.find((item) => item.id === farmId);
  const timezone = farm?.timezone ?? 'America/Cuiaba';
  const [location, setLocation] = useState(asset?.locationId ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const observed = asset?.source === 'unifi';
  const farmLocations = locations.filter((item) => item.farmId === farmId);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const body = {
      name: observed ? asset!.name : value('name'), category: value('category'), tag: value('tag') || null,
      critical: form.get('critical') === 'on', owner: value('owner') || null,
      ip: observed ? asset!.ip : value('ip') || null, mac: observed ? asset!.mac : value('mac') || null,
      locationId: location && location !== NEW_LOCATION ? location : null,
      newLocation: location === NEW_LOCATION ? value('newLocation') || null : null,
      maintenanceUntil: fromLocalInput(value('maintenanceUntil'), timezone),
    };
    setBusy(true);
    setError('');
    try {
      const saved = asset
        ? await requestJson<InventoryAsset>(`/api/assets/${asset.id}`, { method: 'PATCH', json: body })
        : await requestJson<InventoryAsset>('/api/assets', { method: 'POST', json: { ...body, farmId } });
      onSaved(saved);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível salvar o ativo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={asset ? `Editar ${asset.name}` : 'Novo ativo'} labelId="asset-form-title" onClose={onClose}>
      <form className="asset-form" onSubmit={submit}>
        {!asset && (
          <label className="form-field">Fazenda
            <select name="farmId" value={farmId} onChange={(event) => { setFarmId(event.target.value); setLocation(''); }} required>
              {farms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}
        <label className="form-field">Nome
          <input name="name" defaultValue={asset?.name} required maxLength={160} disabled={observed} aria-describedby={observed ? 'name-hint' : undefined} />
          {observed && <small id="name-hint">O nome vem da controladora UniFi.</small>}
        </label>
        <label className="form-field">Categoria<input name="category" defaultValue={asset?.category} required maxLength={80} placeholder="Balança, câmera, tablet…" /></label>
        <label className="form-field">Etiqueta patrimonial<input name="tag" defaultValue={asset?.tag ?? ''} maxLength={80} /></label>
        <label className="form-field">Local técnico
          <select value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="">Sem local</option>
            {farmLocations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value={NEW_LOCATION}>Novo local…</option>
          </select>
        </label>
        {location === NEW_LOCATION && <label className="form-field">Nome do novo local<input name="newLocation" required maxLength={80} placeholder="Portaria, armazém, oficina…" /></label>}
        <label className="form-field">Responsável operacional<input name="owner" defaultValue={asset?.owner ?? ''} maxLength={120} /></label>
        {!observed && <>
          <label className="form-field">Endereço IP<input name="ip" defaultValue={asset?.ip ?? ''} maxLength={80} inputMode="decimal" /></label>
          <label className="form-field">Endereço MAC<input name="mac" defaultValue={asset?.mac ?? ''} maxLength={50} /></label>
        </>}
        <label className="form-field">Manutenção até
          <input name="maintenanceUntil" type="datetime-local" defaultValue={toLocalInput(asset?.maintenanceUntil ?? null, timezone)} aria-describedby="maintenance-hint" />
          <small id="maintenance-hint">Durante a manutenção, o ativo não envia e-mail de alerta. Horário de {timezoneLabel(timezone)}.</small>
        </label>
        <label className="check-field"><input name="critical" type="checkbox" defaultChecked={asset?.critical} /> Ativo crítico</label>
        {error && <p className="message danger" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>Cancelar</button>
          <button className="button primary" type="submit" disabled={!online || busy || !farmId}>{busy ? 'Salvando…' : 'Salvar ativo'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Inventory({ farms, locations, farmId, canEdit, online, onChanged }: InventoryProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<InventoryAsset>();
  const [editing, setEditing] = useState<InventoryAsset | 'new'>();
  const [reload, setReload] = useState(0);
  const farmsById = new Map(farms.map((farm) => [farm.id, farm]));

  // Trocar filtros volta para a primeira página: a pilha de cursores pertence a uma combinação de filtros.
  const filterKey = JSON.stringify([farmId, debounced, source, status, archived]);
  const [navigation, setNavigation] = useState<{ key: string; cursors: Array<string | null> }>({ key: filterKey, cursors: [null] });
  const cursors = navigation.key === filterKey ? navigation.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const pageIndex = cursors.length - 1;
  const requestKey = `${filterKey}|${cursor ?? ''}|${reload}`;
  const [result, setResult] = useState<{ key: string; page?: Page; error?: string }>();
  const loading = result?.key !== requestKey;
  const page = result?.page;
  const error = result?.key === requestKey ? result.error : undefined;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (farmId !== 'all') params.set('farmId', farmId);
    if (debounced) params.set('q', debounced);
    if (source !== 'all') params.set('source', source);
    if (status !== 'all') params.set('status', status);
    if (archived) params.set('archived', '1');
    if (cursor) params.set('cursor', cursor);
    requestJson<Page>(`/api/assets?${params}`, { signal: controller.signal }).then(
      (next) => setResult({ key: requestKey, page: next }),
      (problem: unknown) => {
        if (controller.signal.aborted) return;
        // Mantém a última consulta visível com o aviso de falha.
        setResult((previous) => ({ key: requestKey, page: previous?.page,
          error: problem instanceof Error ? problem.message : 'Falha ao consultar o inventário.' }));
      },
    );
    return () => controller.abort();
  }, [farmId, debounced, source, status, archived, cursor, requestKey]);

  function reloadCurrent() {
    setReload((value) => value + 1);
    onChanged();
  }

  function goTo(nextCursors: Array<string | null>) {
    setNavigation({ key: filterKey, cursors: nextCursors });
  }

  const items = page?.items ?? [];
  const start = pageIndex * 25;

  return (
    <section className="panel" aria-labelledby="inventory-title" aria-busy={loading}>
      <div className="panel-heading">
        <div><h2 id="inventory-title">Equipamentos</h2><p>Localize um ativo por nome, categoria, etiqueta, IP, MAC ou responsável.</p></div>
        {canEdit && farms.length > 0 && <button className="button primary" type="button" disabled={!online} onClick={() => setEditing('new')}><Plus size={17} aria-hidden="true" /> Novo ativo</button>}
      </div>
      <div className="inventory-filters">
        <label className="search-field"><Search size={18} aria-hidden="true" /><input type="search" placeholder="Buscar equipamento" aria-label="Buscar equipamento" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="filter-field" htmlFor="source-filter">Origem
          <select id="source-filter" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">Todas</option><option value="csv">CSV</option><option value="unifi">UniFi</option><option value="manual">Manual</option>
          </select>
        </label>
        <label className="filter-field" htmlFor="status-filter">Estado
          <select id="status-filter" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">Todos</option><option value="online">Online</option><option value="offline">Offline</option><option value="unknown">Indeterminado</option>
          </select>
        </label>
        <label className="check-field"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> Arquivados</label>
      </div>
      {error && <p className="message warning inventory-message" role="status">{error}{page ? ' Exibindo a última consulta.' : ''}</p>}

      {items.length ? (
        <>
          <div className="table-container inventory-table" role="region" tabIndex={0} aria-label="Tabela do inventário">
            <table aria-label="Equipamentos inventariados">
              <thead><tr><th scope="col" aria-sort="ascending">Equipamento <ArrowDown size={13} aria-hidden="true" /></th><th scope="col">Fazenda</th><th scope="col">Local</th><th scope="col">Origem</th><th scope="col">IP</th><th scope="col">Estado</th></tr></thead>
              <tbody>{items.map((asset) => (
                <tr key={asset.id}>
                  <td><button type="button" className="asset-link" onClick={() => setSelected(asset)}>{asset.name}</button><span className="cell-detail">{asset.category}{asset.tag ? ` · ${asset.tag}` : ''}</span></td>
                  <td>{farmsById.get(asset.farmId)?.name ?? '—'}</td>
                  <td>{asset.locationName ?? '—'}</td>
                  <td><span className="source-badge">{sourceLabels[asset.source]}</span></td>
                  <td className="technical">{asset.ip ?? '—'}</td>
                  <td><StatusBadge {...deviceStatus[asset.status]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="inventory-list" aria-label="Equipamentos inventariados">
            {items.map((asset) => (
              <li key={asset.id}>
                <Box size={18} aria-hidden="true" />
                <div><button type="button" className="asset-link" onClick={() => setSelected(asset)}>{asset.name}</button><span className="cell-detail">{farmsById.get(asset.farmId)?.name ?? '—'} · {sourceLabels[asset.source]}</span></div>
                <StatusBadge {...deviceStatus[asset.status]} />
              </li>
            ))}
          </ul>
        </>
      ) : !loading || page ? (
        <EmptyState title="Nenhum equipamento encontrado">{archived ? 'Nenhum ativo arquivado com estes filtros.' : 'Altere os filtros, cadastre um ativo ou importe o inventário em CSV.'}</EmptyState>
      ) : <p className="empty-state" role="status">Consultando inventário…</p>}
      {page && (page.total > 25 || pageIndex > 0) && (
        <div className="pagination" aria-label="Paginação do inventário">
          <span>{items.length ? `${start + 1}–${start + items.length}` : '0'} de {page.total}</span>
          <button className="button icon-button" type="button" disabled={pageIndex === 0 || loading} onClick={() => goTo(cursors.slice(0, -1))} aria-label="Página anterior"><ArrowLeft size={16} aria-hidden="true" /></button>
          <button className="button icon-button" type="button" disabled={!page.nextCursor || loading} onClick={() => goTo([...cursors, page.nextCursor])} aria-label="Próxima página"><ArrowRight size={16} aria-hidden="true" /></button>
        </div>
      )}
      {selected && !editing && (
        <AssetDetails asset={selected} farm={farmsById.get(selected.farmId)} canEdit={canEdit} online={online}
          onEdit={() => setEditing(selected)} onClose={() => setSelected(undefined)}
          onArchive={async () => {
            const updated = await requestJson<InventoryAsset>(`/api/assets/${selected.id}/archive`, { method: 'POST', json: { archived: !selected.archivedAt } });
            setSelected(updated);
            reloadCurrent();
          }} />
      )}
      {editing && (
        <AssetForm asset={editing === 'new' ? undefined : editing} farms={farms} locations={locations} defaultFarm={farmId} online={online}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => { setEditing(undefined); setSelected(saved); reloadCurrent(); }} />
      )}
    </section>
  );
}
