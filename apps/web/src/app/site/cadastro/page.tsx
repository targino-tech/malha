import type { Metadata } from 'next';
import { PLAN_IDS, type PlanId } from '@/server/site-requests';
import { Reveal } from '../_components/reveal';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { DEMO_HREF, STATIC_SITE, SUPPORT_HREF, onboarding, plans } from '../content';
import styles from '../site.module.css';
import { SignupForm } from './signup-form';

export const metadata: Metadata = {
  title: 'Apoio na implantação | Malha',
  description: 'Peça apoio da equipe para implantar o Malha, software livre e gratuito, nas fazendas do seu grupo.',
  robots: { index: true, follow: true },
};

function StaticSupport() {
  return (
    <div className={styles.formDone}>
      <h2>Peça apoio pelo GitHub</h2>
      <p>Esta é a versão pública do site, sem servidor. Abra uma issue contando quantas fazendas o grupo tem e como a TI acompanha a rede hoje; a equipe responde por lá.</p>
      <a href={SUPPORT_HREF} className={styles.primaryButton} target="_blank" rel="noreferrer">Abrir pedido de apoio <ArrowUpRight size={17} aria-hidden="true" /></a>
      <Link href={DEMO_HREF} className={styles.secondaryButton}>Rodar o demo no seu computador</Link>
    </div>
  );
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ plano?: string | string[] }> }) {
  // A versão estática não lê a URL nem envia formulário: o pedido vai por issue no GitHub.
  if (STATIC_SITE) return <SignupLayout><StaticSupport /></SignupLayout>;
  const { plano } = await searchParams;
  const initial: PlanId = typeof plano === 'string' && (PLAN_IDS as readonly string[]).includes(plano) ? plano as PlanId : 'grupo';
  return (
    <SignupLayout>
      <SignupForm plans={plans.map(({ id, name, audience, min, max, items }) => ({ id, name, audience, min, max, highlight: items[items.length - 1] }))} initialPlan={initial} />
    </SignupLayout>
  );
}

function SignupLayout({ children }: { children: React.ReactNode }) {
  return (
    <section className={`${styles.frame} ${styles.signup}`} aria-labelledby="signup-title">
      <Reveal priority className={styles.signupIntro}>
        <h1 id="signup-title">Vamos conectar<br /><span>as suas fazendas.</span></h1>
        <p className={styles.heroDescription}>Envie os dados abaixo. O Malha é gratuito; aqui você pede apoio da equipe para implantá-lo.</p>
        <ol className={styles.signupSteps}>
          {onboarding.map((step, index) => (
            <li key={step.title}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.title}</strong><p>{step.text}</p></div></li>
          ))}
        </ol>
      </Reveal>
      <Reveal priority delay={0.15}>
        {children}
      </Reveal>
    </section>
  );
}
