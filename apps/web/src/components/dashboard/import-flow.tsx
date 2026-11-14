'use client';

import { useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, UploadCloud } from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';

type Preview = {
  importId: string | null;
  rows: Array<{ line: number; name: string; tag: string; category: string; critical: boolean }>;
  errors: Array<{ line: number; message: string }>;
  total: number;
};

const sample = 'etiqueta,nome,categoria,criticidade,mac,ip\nBAL-001,Balança do armazém,Balança,sim,,\nRAD-001,Rádio da portaria,Rádio,não,,\n';

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'A solicitação não pôde ser concluída.');
  }
  return payload as T;
}

export function ImportFlow({ farms, selectedFarm, online, onImported }: {
  farms: DashboardFarm[];
  selectedFarm: string;
  online: boolean;
  onImported: () => void;
}) {
  const [farmId, setFarmId] = useState(selectedFarm !== 'all' ? selectedFarm : '');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState<'preview' | 'commit'>();
  const [error, setError] = useState('');
  const [imported, setImported] = useState<number>();
  const input = useRef<HTMLInputElement>(null);

  function resetPreview() {
    setPreview(undefined);
    setImported(undefined);
    setError('');
  }

  async function validate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!farmId || !file || busy) return;
    resetPreview();
    setBusy('preview');

    try {
      const form = new FormData();
      form.set('farmId', farmId);
      form.set('file', file);
      const response = await fetch('/api/imports/preview', { method: 'POST', body: form });
      setPreview(await readResponse<Preview>(response));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível validar o CSV.');
    } finally {
      setBusy(undefined);
    }
  }

  async function commit() {
    if (!preview?.importId || busy) return;
    setError('');
    setBusy('commit');

    try {
      const response = await fetch('/api/imports/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: preview.importId }),
      });
      const result = await readResponse<{ imported: number }>(response);
      setImported(result.imported);
      setPreview(undefined);
      setFile(undefined);
      if (input.current) input.current.value = '';
      onImported();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível concluir a importação.');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="content-stack">
      <section className="panel" aria-labelledby="import-title">
        <div className="panel-heading">
          <div><h2 id="import-title">Novo lote</h2><p>Escolha a fazenda e valide a planilha antes de atualizar o inventário.</p></div>
          <a className="button secondary" download="malha-modelo.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`}><Download size={17} aria-hidden="true" /> Baixar modelo</a>
        </div>
        <form className="import-form" onSubmit={validate}>
          <label className="form-field" htmlFor="farm-import">Fazenda de destino
            <select id="farm-import" value={farmId} required disabled={Boolean(busy)} onChange={(event) => { setFarmId(event.target.value); resetPreview(); }}>
              <option value="">Selecione uma fazenda</option>
              {farms.map((farm) => <option value={farm.id} key={farm.id}>{farm.name}</option>)}
            </select>
          </label>
          <div className="upload-zone">
            <FileSpreadsheet size={23} aria-hidden="true" />
            <label htmlFor="csv-file">Arquivo CSV</label>
            <input ref={input} id="csv-file" type="file" accept=".csv,text/csv" disabled={Boolean(busy)} required aria-describedby="file-format" onChange={(event) => { setFile(event.target.files?.[0]); resetPreview(); }} />
            <small id="file-format">CSV em UTF-8, até 5 MiB e 10 mil linhas. Campos obrigatórios: etiqueta, nome e categoria.</small>
          </div>
          <button className="button primary" type="submit" disabled={!farmId || !file || Boolean(busy) || !online}><UploadCloud size={17} aria-hidden="true" />{busy === 'preview' ? 'Validando…' : 'Validar arquivo'}</button>
        </form>
      </section>
      {error && <p role="alert" className="message danger"><CircleAlert size={18} aria-hidden="true" />{error}</p>}
      {imported !== undefined && <p role="status" className="message success"><CircleCheck size={18} aria-hidden="true" />{imported} {imported === 1 ? 'ativo importado' : 'ativos importados'}.</p>}
      {preview && (
        <section className="panel import-preview" aria-labelledby="preview-title">
          <div className="panel-heading" aria-live="polite"><div><h2 id="preview-title">Prévia do lote</h2><p>{preview.total} {preview.total === 1 ? 'linha lida' : 'linhas lidas'} em {file?.name}.</p></div></div>
          {preview.errors.length > 0 && (
            <div className="validation-errors" role="alert"><strong>Corrija os erros antes de importar.</strong><ul>
              {preview.errors.slice(0, 20).map((item, index) => <li key={`${item.line}-${index}`}>{item.line > 0 ? `Linha ${item.line} · ` : ''}{item.message}</li>)}
            </ul>{preview.errors.length > 20 && <p>Exibindo 20 dos {preview.errors.length} erros.</p>}</div>
          )}
          {preview.rows.length > 0 && (
            <div className="table-container" tabIndex={0} aria-label="Prévia do arquivo CSV" role="region">
              <table><thead><tr><th scope="col">Linha</th><th scope="col">Etiqueta</th><th scope="col">Nome</th><th scope="col">Categoria</th><th scope="col">Criticidade</th></tr></thead>
                <tbody>{preview.rows.slice(0, 12).map((row) => <tr key={row.line}><td>{row.line}</td><td className="technical">{row.tag}</td><td>{row.name}</td><td>{row.category}</td><td>{row.critical ? 'Crítico' : 'Padrão'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {preview.importId && preview.errors.length === 0 && (
            <div className="preview-actions">
              {preview.total > 12 && <span>Primeiras 12 linhas da prévia.</span>}
              <button type="button" className="button primary" disabled={Boolean(busy) || !online} onClick={commit}>
                <CircleCheck size={17} aria-hidden="true" />{busy === 'commit' ? 'Importando…' : 'Confirmar importação'}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
