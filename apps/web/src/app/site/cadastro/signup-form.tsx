'use client';

import { ArrowRight, Check, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import type { PlanId } from '@/server/site-requests';
import styles from '../site.module.css';

interface PlanOption { id: PlanId; name: string; audience: string }

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

export function SignupForm({ plans, initialPlan }: { plans: PlanOption[]; initialPlan: PlanId }) {
  const [plan, setPlan] = useState<PlanId>(initialPlan);
  const [state, setState] = useState<State>({ kind: 'idle' });
  // A mesma identidade é reenviada em novas tentativas, então um clique repetido não duplica o cadastro.
  const requestId = useRef<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind === 'sending') return;
    const form = new FormData(event.currentTarget);
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
          email: String(form.get('email') ?? '').trim(),
          company: String(form.get('company') ?? '').trim(),
          farms: Number(form.get('farms')),
          message: String(form.get('message') ?? '').trim() || undefined,
          consent: form.get('consent') === 'on',
          website: String(form.get('website') ?? ''),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'Não foi possível enviar agora. Tente novamente.');
      }
      setState({ kind: 'sent' });
      requestAnimationFrame(() => doneRef.current?.focus());
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : 'Não foi possível enviar agora.' });
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className={styles.formDone} ref={doneRef} tabIndex={-1} role="status">
        <span className={styles.formDoneIcon}><Check size={22} aria-hidden="true" /></span>
        <h2>Solicitação recebida</h2>
        <p>Obrigado. A equipe do Malha vai responder no e-mail informado para agendar a conversa técnica.</p>
        <Link href="/site" className={styles.secondaryButton}>Voltar ao site <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    );
  }

  const sending = state.kind === 'sending';
  return (
    <form className={styles.form} onSubmit={submit} aria-describedby="form-privacy">
      <fieldset className={styles.planPicker}>
        <legend>Plano de interesse</legend>
        <div>
          {plans.map((option) => (
            <label key={option.id} data-checked={plan === option.id}>
              <input type="radio" name="plan" value={option.id} checked={plan === option.id} onChange={() => setPlan(option.id)} />
              <strong>{option.name}</strong>
              <span>{option.audience}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span>Nome</span>
          <input name="name" autoComplete="name" required minLength={2} maxLength={120} />
        </label>
        <label className={styles.field}>
          <span>E-mail corporativo</span>
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
      </div>
      <div className={styles.formRow}>
        <label className={styles.field}>
          <span>Empresa ou grupo</span>
          <input name="company" autoComplete="organization" required minLength={2} maxLength={160} />
        </label>
        <label className={styles.field}>
          <span>Número de fazendas</span>
          <input name="farms" type="number" inputMode="numeric" min={1} max={500} defaultValue={3} required />
        </label>
      </div>
      <label className={styles.field}>
        <span>Conte sobre a rede das fazendas <em>(opcional)</em></span>
        <textarea name="message" rows={4} maxLength={2000} placeholder="Ex.: consoles UniFi, número de antenas, como a TI acompanha as unidades hoje." />
      </label>
      <label className={styles.honeypot} aria-hidden="true">
        Site
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <label className={styles.consent}>
        <input type="checkbox" name="consent" required />
        <span id="form-privacy">Autorizo o uso destes dados somente para o contato sobre a contratação do Malha.</span>
      </label>

      {state.kind === 'error' && <p className={styles.formError} role="alert" tabIndex={-1} ref={errorRef}>{state.message}</p>}

      <button type="submit" className={styles.primaryButton} disabled={sending}>
        {sending ? <><LoaderCircle size={18} className={styles.spin} aria-hidden="true" /> Enviando…</> : <>Enviar cadastro <ArrowRight size={18} aria-hidden="true" /></>}
      </button>
    </form>
  );
}
