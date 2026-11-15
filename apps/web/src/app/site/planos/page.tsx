import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, Check } from 'lucide-react';
import { Reveal } from '../_components/reveal';
import { included, onboarding, plans } from '../content';
import styles from '../site.module.css';

export const metadata: Metadata = {
  title: 'Planos | Malha',
  description: 'Planos do Malha para fazendas e grupos agrícolas. Comece por um piloto e amplie para todas as unidades.',
  robots: { index: true, follow: true },
};

export default function PlansPage() {
  return (
    <>
      <section className={`${styles.frame} ${styles.pageHero}`} aria-labelledby="plans-page-title">
        <Reveal priority>
          <h1 id="plans-page-title">Do piloto<br /><span>ao grupo inteiro.</span></h1>
          <p className={styles.heroDescription}>O painel é o mesmo em todos os planos. A diferença está no número de fazendas e no acompanhamento da implantação.</p>
        </Reveal>
      </section>

      <section className={`${styles.frame} ${styles.sectionTight}`} aria-label="Planos disponíveis">
        <ul className={styles.planGrid}>
          {plans.map((plan) => (
            <li key={plan.id}>
              <Reveal className={styles.planCard}>
                <article data-recommended={plan.recommended || undefined} aria-labelledby={`plan-${plan.id}`}>
                  <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                  <p className={styles.planTagline}>{plan.tagline}</p>
                  <p className={styles.planAudience}>{plan.audience}</p>
                  <ul>
                    {plan.items.map((item) => <li key={item}><Check size={16} aria-hidden="true" /> {item}</li>)}
                  </ul>
                  <Link href={`/site/cadastro?plano=${plan.id}`} className={plan.recommended ? styles.primaryButton : styles.secondaryButton}
                    aria-label={`Solicitar acesso ao plano ${plan.name}`}>
                    Solicitar acesso <ArrowUpRight size={17} aria-hidden="true" />
                  </Link>
                </article>
              </Reveal>
            </li>
          ))}
        </ul>
        <p className={styles.planNote}>O valor sai na proposta e depende do número de fazendas e de coletores. Não há cobrança antes da conversa técnica.</p>
      </section>

      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="included-title">
        <Reveal className={styles.sectionHeading}>
          <h2 id="included-title">Em todos os planos, o painel completo.</h2>
        </Reveal>
        <ul className={styles.includedList}>
          {included.map((item) => (
            <li key={item}><Check size={16} aria-hidden="true" /> {item}</li>
          ))}
        </ul>
      </section>

      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="steps-title">
        <Reveal className={styles.sectionHeading}>
          <h2 id="steps-title">Como começar</h2>
        </Reveal>
        <ol className={styles.stepsList}>
          {onboarding.map((step, index) => (
            <li key={step.title}>
              <Reveal className={styles.stepItem}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </Reveal>
            </li>
          ))}
        </ol>
        <Reveal className={styles.centerActions}>
          <Link href="/site/cadastro" className={styles.primaryButton}>Solicitar acesso <ArrowUpRight size={18} aria-hidden="true" /></Link>
        </Reveal>
      </section>
    </>
  );
}
