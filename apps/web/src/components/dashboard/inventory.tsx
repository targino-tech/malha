'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, Box, Search, X } from 'lucide-react';
import type { DashboardAsset, DashboardFarm } from '../../server/dashboard';
import { deviceStatus, EmptyState, formatDate, StatusBadge } from './presentation';

const pageSize = 12;

type InventoryProps = {
  assets: DashboardAsset[];
  farms: DashboardFarm[];
};

function AssetDetails({ asset, farm, onClose }: { asset: DashboardAsset; farm?: DashboardFarm; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  function close() {
    dialog.current?.close();
    onClose();
  }

  return (
    <dialog ref={dialog} className="asset-dialog" aria-labelledby="asset-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="panel-heading">
        <div>
          <h2 id="asset-title">{asset.name}</h2>
          <p>{farm?.name ?? 'Fazenda'} · {asset.category}</p>
        </div>
        <button className="button icon-button" type="button" onClick={close} aria-label="Fechar detalhes"><X size={20} aria-hidden="true" /></button>
      </div>
      <div className="asset-details">
        <StatusBadge {...deviceStatus[asset.status]} />
        <dl>
          <div><dt>Etiqueta</dt><dd>{asset.tag ?? '—'}</dd></div>
          <div><dt>Origem</dt><dd>{asset.source === 'unifi' ? 'UniFi' : 'CSV'}</dd></div>
          <div><dt>Endereço IP</dt><dd className="technical">{asset.ip ?? '—'}</dd></div>
          <div><dt>Endereço MAC</dt><dd className="technical">{asset.mac ?? '—'}</dd></div>
          <div><dt>Criticidade</dt><dd>{asset.critical ? 'Crítico' : 'Padrão'}</dd></div>
          <div><dt>Última observação</dt><dd>{formatDate(asset.lastObservedAt)}</dd></div>
        </dl>
      </div>
    </dialog>
  );
}

export function Inventory({ assets, farms }: InventoryProps) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [assetId, setAssetId] = useState<string>();

  const farmsById = new Map(farms.map((farm) => [farm.id, farm]));
  const assetDetails = assets.find((asset) => asset.id === assetId);
  const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR');
  const filtered = assets.filter((asset) => (
    (source === 'all' || asset.source === source) && (status === 'all' || asset.status === status)
    && [asset.name, asset.category, asset.tag, asset.ip, asset.mac].some((value) => value?.toLocaleLowerCase('pt-BR').includes(normalizedQuery))
  )).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const start = currentPage * pageSize;
  const visibleAssets = filtered.slice(start, start + pageSize);

  return (
    <section className="panel" aria-labelledby="inventory-title">
      <div className="panel-heading"><div><h2 id="inventory-title">Equipamentos</h2><p>Localize um ativo por nome, categoria, etiqueta, IP ou MAC.</p></div></div>
      <div className="inventory-filters">
        <label className="search-field"><Search size={18} aria-hidden="true" /><input type="search" placeholder="Buscar equipamento" aria-label="Buscar equipamento" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
        <label className="filter-field" htmlFor="source-filter">Origem
          <select id="source-filter" value={source} onChange={(event) => { setSource(event.target.value); setPage(0); }}>
            <option value="all">Todas</option><option value="csv">CSV</option><option value="unifi">UniFi</option>
          </select>
        </label>
        <label className="filter-field" htmlFor="status-filter">Estado
          <select id="status-filter" value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}>
            <option value="all">Todos</option><option value="online">Online</option><option value="offline">Offline</option><option value="unknown">Indeterminado</option>
          </select>
        </label>
      </div>

      {visibleAssets.length ? (
        <>
          <div className="table-container inventory-table" role="region" tabIndex={0} aria-label="Tabela do inventário">
            <table aria-label="Equipamentos inventariados">
              <thead><tr><th scope="col" aria-sort="ascending">Equipamento <ArrowDown size={13} aria-hidden="true" /></th><th scope="col">Fazenda</th><th scope="col">Origem</th><th scope="col">IP</th><th scope="col">Estado</th></tr></thead>
              <tbody>{visibleAssets.map((asset) => (
                <tr key={asset.id}>
                  <td><button type="button" className="asset-link" onClick={() => setAssetId(asset.id)}>{asset.name}</button><span className="cell-detail">{asset.category}{asset.tag ? ` · ${asset.tag}` : ''}</span></td>
                  <td>{farmsById.get(asset.farmId)?.name ?? '—'}</td>
                  <td><span className="source-badge">{asset.source === 'unifi' ? 'UniFi' : 'CSV'}</span></td>
                  <td className="technical">{asset.ip ?? '—'}</td>
                  <td><StatusBadge {...deviceStatus[asset.status]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="inventory-list" aria-label="Equipamentos inventariados">
            {visibleAssets.map((asset) => (
              <li key={asset.id}>
                <Box size={18} aria-hidden="true" />
                <div><button type="button" className="asset-link" onClick={() => setAssetId(asset.id)}>{asset.name}</button><span className="cell-detail">{farmsById.get(asset.farmId)?.name ?? '—'} · {asset.source === 'unifi' ? 'UniFi' : 'CSV'}</span></div>
                <StatusBadge {...deviceStatus[asset.status]} />
              </li>
            ))}
          </ul>
        </>
      ) : <EmptyState title="Nenhum equipamento encontrado">Altere os filtros ou importe o inventário em CSV.</EmptyState>}
      {filtered.length > pageSize && (
        <div className="pagination" aria-label="Paginação do inventário">
          <span>{start + 1}–{start + visibleAssets.length} de {filtered.length}</span>
          <button className="button icon-button" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Página anterior"><ArrowLeft size={16} aria-hidden="true" /></button>
          <button className="button icon-button" type="button" disabled={start + pageSize >= filtered.length} onClick={() => setPage(currentPage + 1)} aria-label="Próxima página"><ArrowRight size={16} aria-hidden="true" /></button>
        </div>
      )}
      {assetDetails && <AssetDetails asset={assetDetails} farm={farmsById.get(assetDetails.farmId)} onClose={() => setAssetId(undefined)} />}
    </section>
  );
}
