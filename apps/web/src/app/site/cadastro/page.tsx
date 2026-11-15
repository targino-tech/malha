import type { Metadata } from 'next';
import { PLAN_IDS, type PlanId } from '@/server/site-requests';
import { Reveal } from '../_components/reveal';
import { onboarding, plans } from '../content';
import styles from '../site.module.css';
import { SignupForm } from './signup-form';

export const metadata: Metadata = {
  title: 'Cadastro | Malha',
  description: 'Solicite o Malha para as fazendas do seu grupo.',
  robots: { index: true, follow: true },
};

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ plano?: string | string[] }> }) {
  const { plano } = await searchParams;
  const initial: PlanId = typeof plano === 'string' && (PLAN_IDS as readonly string[]).includes(plano) ? plano as PlanId : 'grupo';
  return (
    <section className={`${styles.frame} ${styles.signup}`} aria-labelledby="signup-title">
      <Reveal priority className={styles.signupIntro}>
        <h1 id="signup-title">Vamos conectar<br /><span>as suas fazendas.</span></h1>
        <p className={styles.heroDescription}>Envie os dados abaixo. A equipe responde por e-mail para agendar a conversa técnica.</p>
        <ol className={styles.signupSteps}>
          {onboarding.map((step, index) => (
            <li key={step.title}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.title}</strong><p>{step.text}</p></div></li>
          ))}
        </ol>
      </Reveal>
      <Reveal priority delay={0.15}>
        <SignupForm plans={plans.map(({ id, name, audience, min, max, items }) => ({ id, name, audience, min, max, highlight: items[items.length - 1] }))} initialPlan={initial} />
      </Reveal>
    </section>
  );
}
