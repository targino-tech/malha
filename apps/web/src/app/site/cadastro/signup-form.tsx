'use client';

import { ArrowRight, Check, Info, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import type { PlanId } from '@/server/site-requests';
import styles from '../site.module.css';

interface PlanOption { id: PlanId; name: string; audience: string; min: number; max: number; highlight: string }

type Field = 'name' | 'email' | 'company' | 'farms' | 'consent';
type Errors = Partial<Record<Field, string>>;
type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string };

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(form: FormData): Errors {
  const errors: Errors = {};
  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const company = String(form.get('company') ?? '').trim();
  const farms = Number(form.get('farms'));
  if (name.length < 2) errors.name = 'Informe seu nome.';
  if (!emailPattern.test(email)) errors.email = 'Informe um e-mail no formato nome@empresa.com.br.';
  if (company.length < 2) errors.company = 'Informe o nome da empresa ou do grupo.';
  if (!Number.isInteger(farms) || farms < 1) errors.farms = 'Informe quantas fazendas, a partir de 1.';
  else if (farms > 500) errors.farms = 'Para mais de 500 fazendas, conte o total na mensagem e informe 500.';
  if (form.get('consent') !== 'on') errors.consent = 'Marque a autorização para que possamos responder.';
  return errors;
}

export function SignupForm({ plans, initialPlan }: { plans: PlanOption[]; initialPlan: PlanId }) {
  const [plan, setPlan] = useState<PlanId>(initialPlan);
  const [farms, setFarms] = useState(String(plans.find((option) => option.id === initialPlan)?.min ?? 1));
  const [errors, setErrors] = useState<Errors>({});
  const [state, setState] = useState<State>({ kind: 'idle' });
  // A mesma identidade é reenviada em novas tentativas, então um clique repetido não duplica o cadastro.
  const requestId = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  const selected = plans.find((option) => option.id === plan)!;
  const farmCount = Number(farms);
  const suggested = Number.isInteger(farmCount) && farmCount > 0
    ? plans.find((option) => farmCount >= option.min && farmCount <= option.max)
    : undefined;
  const mismatch = suggested && suggested.id !== plan ? suggested : undefined;

  function clearError(field: Field) {
    if (!errors[field]) return;
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind === 'sending') return;
    const form = new FormData(event.currentTarget);
    const found = validate(form);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    const email = String(form.get('email') ?? '').trim();
    requestId.current ??= crypto.randomUUID();
    setState({ kind: 'sending' });
    try {
      const response = await fetch('/api/site/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: requestId.current,
          plan,
          name: String(form.get('name') ?? '').trim(),
          email,
          company: String(form.get('company') ?? '').trim(),
          farms: Number(form.get('farms')),
          message: String(form.get('message') ?? '').trim() || undefined,
          consent: true,
          website: String(form.get('website') ?? ''),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'O envio não foi concluído. Confira a conexão e tente de novo; seus dados continuam preenchidos.');
      }
      setState({ kind: 'sent', email });
      requestAnimationFrame(() => doneRef.current?.focus());
    } catch (error) {
      const offline = error instanceof TypeError;
      setState({ kind: 'error', message: offline
        ? 'Sem conexão com o Malha. Confira a internet e tente de novo; seus dados continuam preenchidos.'
        : error instanceof Error ? error.message : 'O envio não foi concluído. Tente de novo.' });
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className={styles.formDone} ref={doneRef} tabIndex={-1} role="status">
        <span className={styles.formDoneIcon}><Check size={22} aria-hidden="true" /></span>
        <h2>Solicitação recebida</h2>
        <p>A equipe do Malha vai responder em <strong>{state.email}</strong> para agendar a conversa técnica sobre o plano {selected.name}.</p>
        <p>Na conversa, tenha em mãos o modelo da console UniFi de cada fazenda e o diretório Microsoft do grupo.</p>
        <Link href="/site" className={styles.secondaryButton}>Voltar ao site <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    );
  }

  const sending = state.kind === 'sending';
  const describe = (field: Field, extra?: string) => [errors[field] ? `${field}-error` : null, extra].filter(Boolean).join(' ') || undefined;
  const fieldError = (field: Field) => errors[field] && <span id={`${field}-error`} className={styles.fieldError}>{errors[field]}</span>;

  return (
    <form ref={formRef} className={styles.form} onSubmit={submit} noValidate>
      <fieldset className={styles.planPicker}>
        <legend>Plano de interesse</legend>
        <div>
          {plans.map((option) => (
            <label key={option.id} data-checked={plan === option.id}>
              <input type="radio" name="plan" value={option.id} checked={plan === option.id} onChange={() => setPlan(option.id)} />
              <strong>{option.name}</strong>
              <span>{option.audience}</span>
              <small>{option.highlight}</small>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.formRow}>
        <label className={styles.field} data-invalid={Boolean(errors.name) || undefined}>
          <span>Nome</span>
          <input name="name" autoComplete="name" maxLength={120} aria-invalid={Boolean(errors.name)} aria-describedby={describe('name')} onInput={() => clearError('name')} />
          {fieldError('name')}
        </label>
        <label className={styles.field} data-invalid={Boolean(errors.email) || undefined}>
          <span>E-mail corporativo</span>
          <input name="email" type="email" autoComplete="email" maxLength={254} aria-invalid={Boolean(errors.email)} aria-describedby={describe('email')} onInput={() => clearError('email')} />
          {fieldError('email')}
        </label>
      </div>
      <div className={styles.formRow}>
        <label className={styles.field} data-invalid={Boolean(errors.company) || undefined}>
          <span>Empresa ou grupo</span>
          <input name="company" autoComplete="organization" maxLength={160} aria-invalid={Boolean(errors.company)} aria-describedby={describe('company')} onInput={() => clearError('company')} />
          {fieldError('company')}
        </label>
        <label className={styles.field} data-invalid={Boolean(errors.farms) || undefined}>
          <span>Número de fazendas</span>
          <input name="farms" type="number" inputMode="numeric" min={1} max={500} value={farms}
            aria-invalid={Boolean(errors.farms)} aria-describedby={describe('farms', mismatch ? 'farms-hint' : undefined)}
            onChange={(event) => { setFarms(event.target.value); clearError('farms'); }} />
          {fieldError('farms')}
        </label>
      </div>
      {mismatch && (
        <p id="farms-hint" className={styles.formHint} aria-live="polite">
          <Info size={16} aria-hidden="true" />
          <span>Para {farmCount} {farmCount === 1 ? 'fazenda' : 'fazendas'}, o plano indicado é o {mismatch.name}.{' '}
            <button type="button" onClick={() => setPlan(mismatch.id)}>Trocar para {mismatch.name}</button></span>
        </p>
      )}
      <label className={styles.field}>
        <span>Conte sobre a rede das fazendas <em>(opcional)</em></span>
        <textarea name="message" rows={4} maxLength={2000} placeholder="Ex.: consoles UniFi, número de antenas, como a TI acompanha as unidades hoje." />
      </label>
      <label className={styles.honeypot} aria-hidden="true">
        Site
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <div className={styles.consentWrap}>
        <label className={styles.consent} data-invalid={Boolean(errors.consent) || undefined}>
          <input type="checkbox" name="consent" aria-invalid={Boolean(errors.consent)} aria-describedby={describe('consent')} onChange={() => clearError('consent')} />
          <span>Autorizo o uso destes dados somente para o contato sobre a contratação do Malha.</span>
        </label>
        <Link href="/site/privacidade" className={styles.consentLink}>Como usamos estes dados</Link>
        {fieldError('consent')}
      </div>

      {state.kind === 'error' && <p className={styles.formError} role="alert" tabIndex={-1} ref={errorRef}>{state.message}</p>}

      <button type="submit" className={styles.primaryButton} disabled={sending}>
        {sending ? <><LoaderCircle size={18} className={styles.spin} aria-hidden="true" /> Enviando…</> : <>Enviar solicitação <ArrowRight size={18} aria-hidden="true" /></>}
      </button>
    </form>
  );
}
