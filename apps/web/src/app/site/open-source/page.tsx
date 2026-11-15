import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, Check } from 'lucide-react';
import { Reveal } from '../_components/reveal';
import { REPOSITORY_URL, included, onboarding, openSource } from '../content';
import styles from '../site.module.css';

export const metadata: Metadata = {
  title: 'Open source | Malha',
  description: 'O Malha é gratuito e open source sob a licença AGPL-3.0. Hospede você mesmo ou peça apoio na implantação.',
  robots: { index: true, follow: true },
};

export default function OpenSourcePage() {
  return (
    <>
      <section className={`${styles.frame} ${styles.pageHero}`} aria-labelledby="oss-page-title">
        <Reveal priority>
          <h1 id="oss-page-title">Grátis<br /><span>e open source.</span></h1>
          <p className={styles.heroDescription}>O Malha é software livre sob a licença AGPL-3.0. Não há plano pago nem recurso bloqueado: o painel completo é o mesmo para qualquer grupo.</p>
          <div className={styles.heroActions}>
            <a href={REPOSITORY_URL} className={styles.primaryButton} target="_blank" rel="noreferrer">Ver o código no GitHub <ArrowUpRight size={18} aria-hidden="true" /></a>
            <Link href="/site/cadastro" className={styles.secondaryButton}>Pedir apoio na implantação</Link>
          </div>
        </Reveal>
      </section>

      <section className={`${styles.frame} ${styles.sectionTight}`} aria-label="Como usar o Malha">
        <ul className={styles.planGrid}>
          {openSource.map((item, index) => (
            <li key={item.title}>
              <Reveal className={styles.planCard}>
                <article data-recommended={index === 0 || undefined} aria-labelledby={`oss-${index}`}>
                  <h2 id={`oss-${index}`}>{item.title}</h2>
                  <p className={styles.planTagline}>{item.text}</p>
                </article>
              </Reveal>
            </li>
          ))}
        </ul>
        <p className={styles.planNote}>Distribuído sob a <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">GNU Affero General Public License v3.0</a>.</p>
      </section>

      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="included-title">
        <Reveal className={styles.sectionHeading}>
          <h2 id="included-title">Tudo incluído, sem custo de licença.</h2>
        </Reveal>
        <ul className={styles.includedList}>
          {included.map((item) => (
            <li key={item}><Check size={16} aria-hidden="true" /> {item}</li>
          ))}
        </ul>
      </section>

      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="steps-title">
        <Reveal className={styles.sectionHeading}>
          <h2 id="steps-title">Implantação com a equipe</h2>
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
          <Link href="/site/cadastro" className={styles.primaryButton}>Pedir apoio <ArrowUpRight size={18} aria-hidden="true" /></Link>
        </Reveal>
      </section>
    </>
  );
}
