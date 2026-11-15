import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, Check } from 'lucide-react';
import { Reveal } from '../_components/reveal';
import { capabilities, onboarding, plans } from '../content';
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
          <p className={styles.eyebrow}><span className={styles.liveDot} /> Planos</p>
          <h1 id="plans-page-title">Do piloto<br /><span>ao grupo inteiro.</span></h1>
          <p className={styles.heroDescription}>Todos os planos incluem o painel completo. A diferença está no tamanho da operação e no acompanhamento da implantação.</p>
        </Reveal>
      </section>

      <section className={`${styles.frame} ${styles.sectionTight}`} aria-label="Planos disponíveis">
        <ul className={styles.planGrid}>
          {plans.map((plan, index) => (
            <li key={plan.id}>
              <Reveal className={styles.planCard} delay={index * 0.08}>
                <article data-featured={plan.featured || undefined} aria-labelledby={`plan-${plan.id}`}>
                  {plan.featured && <p className={styles.planBadge}>Mais escolhido</p>}
                  <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                  <p className={styles.planTagline}>{plan.tagline}</p>
                  <p className={styles.planPrice}>Sob consulta</p>
                  <p className={styles.planAudience}>{plan.audience}</p>
                  <ul>
                    {plan.items.map((item) => <li key={item}><Check size={16} aria-hidden="true" /> {item}</li>)}
                  </ul>
                  <Link href={`/site/cadastro?plano=${plan.id}`} className={plan.featured ? styles.primaryButton : styles.secondaryButton}>
                    Solicitar {plan.name} <ArrowUpRight size={17} aria-hidden="true" />
                  </Link>
                </article>
              </Reveal>
            </li>
          ))}
        </ul>
        <p className={styles.planNote}>Valores definidos em proposta, conforme o número de fazendas e de coletores.</p>
      </section>

      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="included-title">
        <Reveal className={styles.sectionHeading}>
          <p className={styles.sectionIndex}><span>Em todos os planos</span></p>
          <h2 id="included-title">O painel completo, desde o primeiro dia.</h2>
        </Reveal>
        <ul className={styles.includedList}>
          {capabilities.map((item) => (
            <li key={item.code}><span className={styles.capabilityCode}>{item.code}</span> {item.title}</li>
          ))}
        </ul>
      </section>

      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="steps-title">
        <Reveal className={styles.sectionHeading}>
          <p className={styles.sectionIndex}><span>Contratação</span></p>
          <h2 id="steps-title">Como começar</h2>
        </Reveal>
        <ol className={styles.stepsList}>
          {onboarding.map((step, index) => (
            <li key={step.title}>
              <Reveal className={styles.stepItem} delay={index * 0.08}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </Reveal>
            </li>
          ))}
        </ol>
        <Reveal className={styles.centerActions}>
          <Link href="/site/cadastro" className={styles.primaryButton}>Começar o cadastro <ArrowUpRight size={18} aria-hidden="true" /></Link>
        </Reveal>
      </section>
    </>
  );
}
