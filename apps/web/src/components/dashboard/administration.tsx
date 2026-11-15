'use client';

import { useEffect, useState } from 'react';
import { Building2, Pencil, Plus, UserMinus, UserPlus, Users } from 'lucide-react';
import type { Member } from '../../server/admin';
import { roleLabels, ROLES, type Role } from '../../server/authz';
import type { DashboardFarm } from '../../server/dashboard';
import { EmptyState, requestJson, StatusBadge, timezoneLabel } from './presentation';

const TIMEZONES = ['America/Cuiaba', 'America/Campo_Grande', 'America/Sao_Paulo', 'America/Porto_Velho', 'America/Manaus', 'America/Bahia', 'America/Belem'];

function FarmForm({ farm, online, onSaved, onCancel }: { farm?: DashboardFarm; online: boolean; onSaved: () => void; onCancel?: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = { name: data.get('name'), location: data.get('location'), timezone: data.get('timezone'), latitude: data.get('latitude'), longitude: data.get('longitude') };
    setBusy(true);
    setError('');
    try {
      await requestJson(farm ? `/api/farms/${farm.id}` : '/api/farms', { method: farm ? 'PATCH' : 'POST', json: body });
      if (!farm) form.reset();
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível salvar a fazenda.');
    } finally {
      setBusy(false);
    }
  }
  const prefix = farm ? `farm-${farm.id}` : 'farm-new';
  return (
    <form className="inline-form" onSubmit={submit} aria-label={farm ? `Editar ${farm.name}` : 'Nova fazenda'}>
      <label className="form-field" htmlFor={`${prefix}-name`}>Nome da fazenda<input id={`${prefix}-name`} name="name" defaultValue={farm?.name} required maxLength={120} /></label>
      <label className="form-field" htmlFor={`${prefix}-location`}>Município · UF<input id={`${prefix}-location`} name="location" defaultValue={farm?.location} required maxLength={120} placeholder="Sorriso · MT" /></label>
      <label className="form-field" htmlFor={`${prefix}-latitude`}>Latitude <small>(opcional)</small><input id={`${prefix}-latitude`} name="latitude" inputMode="decimal" defaultValue={farm?.latitude ?? ''} placeholder="-12,55" /></label>
      <label className="form-field" htmlFor={`${prefix}-longitude`}>Longitude <small>(opcional)</small><input id={`${prefix}-longitude`} name="longitude" inputMode="decimal" defaultValue={farm?.longitude ?? ''} placeholder="-55,71" /></label>
      <label className="form-field" htmlFor={`${prefix}-timezone`}>Fuso horário
        <select id={`${prefix}-timezone`} name="timezone" defaultValue={farm?.timezone ?? 'America/Cuiaba'}>
          {[...new Set([...(farm ? [farm.timezone] : []), ...TIMEZONES])].map((zone) => <option key={zone} value={zone}>{timezoneLabel(zone)}</option>)}
        </select>
      </label>
      <div className="inline-actions">
        {onCancel && <button className="button secondary" type="button" onClick={onCancel}>Cancelar</button>}
        <button className="button primary" type="submit" disabled={!online || busy}>{farm ? 'Salvar fazenda' : <><Plus size={16} aria-hidden="true" /> Cadastrar fazenda</>}</button>
      </div>
      {error && <p className="message danger" role="alert">{error}</p>}
    </form>
  );
}

function MemberForm({ member, farms, online, onSaved, onCancel }: {
  member?: Member; farms: DashboardFarm[]; online: boolean; onSaved: () => void; onCancel?: () => void;
}) {
  const [role, setRole] = useState<Role>(member?.role ?? 'ti');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const oid = String(member?.oid ?? data.get('oid') ?? '').trim();
    const body = { displayName: data.get('displayName'), role, farmIds: role === 'admin' ? [] : data.getAll('farmIds') };
    setBusy(true);
    setError('');
    try {
      await requestJson(`/api/members/${encodeURIComponent(oid)}`, { method: 'PUT', json: body });
      if (!member) { form.reset(); setRole('ti'); }
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível salvar o membro.');
    } finally {
      setBusy(false);
    }
  }
  const prefix = member ? `member-${member.oid}` : 'member-new';
  return (
    <form className="inline-form" onSubmit={submit} aria-label={member ? `Editar ${member.displayName ?? member.oid}` : 'Novo membro'}>
      {!member && (
        <label className="form-field" htmlFor={`${prefix}-oid`}>Object ID (OID) no Entra ID
          <input id={`${prefix}-oid`} name="oid" required className="technical" pattern="[0-9a-fA-F-]{36}" placeholder="00000000-0000-0000-0000-000000000000" />
        </label>
      )}
      <label className="form-field" htmlFor={`${prefix}-name`}>Nome de exibição<input id={`${prefix}-name`} name="displayName" defaultValue={member?.displayName ?? ''} maxLength={120} /></label>
      <label className="form-field" htmlFor={`${prefix}-role`}>Papel
        <select id={`${prefix}-role`} value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
        </select>
      </label>
      {role !== 'admin' && (
        <fieldset className="farm-checks">
          <legend>{role === 'tecnico' ? 'Fazendas atribuídas (obrigatório)' : 'Restringir às fazendas (vazio = todas)'}</legend>
          {farms.map((farm) => (
            <label key={farm.id} className="check-field"><input type="checkbox" name="farmIds" value={farm.id} defaultChecked={member?.farmIds.includes(farm.id)} /> {farm.name}</label>
          ))}
        </fieldset>
      )}
      <div className="inline-actions">
        {onCancel && <button className="button secondary" type="button" onClick={onCancel}>Cancelar</button>}
        <button className="button primary" type="submit" disabled={!online || busy}>{member ? 'Salvar membro' : <><UserPlus size={16} aria-hidden="true" /> Adicionar membro</>}</button>
      </div>
      {error && <p className="message danger" role="alert">{error}</p>}
    </form>
  );
}

export function Administration({ farms, actor, online, onChanged }: { farms: DashboardFarm[]; actor: string; online: boolean; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[]>();
  const [error, setError] = useState('');
  const [editingFarm, setEditingFarm] = useState<string>();
  const [editingMember, setEditingMember] = useState<string>();

  const [reload, setReload] = useState(0);
  const loadMembers = () => setReload((value) => value + 1);
  useEffect(() => {
    let active = true;
    requestJson<Member[]>('/api/members').then(
      (next) => { if (active) { setMembers(next); setError(''); } },
      (problem: unknown) => { if (active) setError(problem instanceof Error ? problem.message : 'Falha ao consultar os membros.'); },
    );
    return () => { active = false; };
  }, [reload]);

  async function deactivate(member: Member) {
    if (!window.confirm(`Desativar o acesso de ${member.displayName ?? member.oid}? As sessões abertas no Malha serão encerradas.`)) return;
    try {
      await requestJson(`/api/members/${member.oid}`, { method: 'DELETE' });
      loadMembers();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Não foi possível desativar o membro.');
    }
  }

  const farmNames = new Map(farms.map((farm) => [farm.id, farm.name]));

  return (
    <div className="content-stack">
      <section className="panel" aria-labelledby="admin-farms-title">
        <div className="panel-heading"><div><h2 id="admin-farms-title"><Building2 size={18} aria-hidden="true" /> Fazendas</h2><p>Unidades do grupo. O fuso define a exibição de horários e e-mails.</p></div></div>
        <div className="admin-body"><FarmForm online={online} onSaved={onChanged} /></div>
        <ul className="admin-list" aria-label="Fazendas cadastradas">
          {farms.map((farm) => (
            <li key={farm.id}>
              {editingFarm === farm.id ? (
                <FarmForm farm={farm} online={online} onCancel={() => setEditingFarm(undefined)} onSaved={() => { setEditingFarm(undefined); onChanged(); }} />
              ) : (
                <div className="admin-row">
                  <div><strong>{farm.name}</strong><span>{farm.location} · {timezoneLabel(farm.timezone)}</span></div>
                  <button className="button icon-button" type="button" onClick={() => setEditingFarm(farm.id)} aria-label={`Editar ${farm.name}`}><Pencil size={16} aria-hidden="true" /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="admin-members-title">
        <div className="panel-heading"><div><h2 id="admin-members-title"><Users size={18} aria-hidden="true" /> Membros</h2><p>Quem entra pelo Entra ID e o que pode fazer. A mudança vale na próxima requisição do usuário.</p></div></div>
        <div className="admin-body"><MemberForm farms={farms} online={online} onSaved={loadMembers} /></div>
        {error && <p className="message danger occurrence-error" role="alert">{error}</p>}
        {members && !members.length && <EmptyState title="Nenhum membro cadastrado">Adicione o OID de cada pessoa que acessa o Malha.</EmptyState>}
        <ul className="admin-list" aria-label="Membros do grupo">
          {members?.map((member) => (
            <li key={member.oid}>
              {editingMember === member.oid ? (
                <MemberForm member={member} farms={farms} online={online} onCancel={() => setEditingMember(undefined)}
                  onSaved={() => { setEditingMember(undefined); loadMembers(); }} />
              ) : (
                <div className="admin-row">
                  <div>
                    <strong>{member.displayName ?? 'Sem nome'}</strong>
                    <span className="technical">{member.oid}</span>
                    <span>{roleLabels[member.role]}{member.farmIds.length ? ` · ${member.farmIds.map((id) => farmNames.get(id) ?? 'Fazenda').join(', ')}` : member.role === 'admin' ? '' : ' · todas as fazendas'}</span>
                  </div>
                  <div className="inline-actions">
                    {!member.active && <StatusBadge label="Inativo" icon={UserMinus} tone="neutral" />}
                    <button className="button icon-button" type="button" onClick={() => setEditingMember(member.oid)} aria-label={`Editar ${member.displayName ?? member.oid}`}><Pencil size={16} aria-hidden="true" /></button>
                    {member.active && member.oid !== actor && (
                      <button className="button icon-button" type="button" disabled={!online} onClick={() => { void deactivate(member); }} aria-label={`Desativar ${member.displayName ?? member.oid}`}><UserMinus size={16} aria-hidden="true" /></button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
