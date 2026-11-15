import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Check, ChevronDown } from 'lucide-react';
import { DashboardPreview } from './_components/dashboard-preview';
import { FieldStory } from './_components/field-story';
import { CinematicHero } from './_components/hero';
import { Reveal, SceneTitle, ScrollScale, TiltIn } from './_components/reveal';
import { capabilities, facts, plans, questions, security } from './content';
import styles from './site.module.css';

const title = 'Malha | Inventário de rede e ativos para fazendas';
const description = 'Acompanhe ativos, coletores e equipamentos de rede de várias fazendas no mesmo painel. Integre UniFi ou importe seu inventário em CSV.';

export const metadata: Metadata = {
  title,
  description,
  robots: { index: true, follow: true },
  openGraph: { type: 'website', locale: 'pt_BR', siteName: 'Malha', title, description },
};

function SectionHeading({ title, text, id }: { title: string; text?: string; id: string }) {
  return <SceneTitle className={styles.sectionHeading} id={id} title={title} text={text} />;
}

function Rows() {
  return <div className={styles.rows} aria-hidden="true" />;
}

export default function SitePage() {
  return (
    <>
      <CinematicHero facts={facts} />

      <section id="produto" className={`${styles.frame} ${styles.section}`} aria-labelledby="produto-title">
        <div className={styles.split}>
          <SectionHeading id="produto-title" title="Tudo o que a TI do campo precisa ver." text="O Malha junta o que a console UniFi observa com o inventário que a sua equipe já mantém, separado por fazenda." />
          <ul className={styles.capabilityList}>
            {capabilities.map((item) => (
              <li key={item.title}>
                <Reveal className={styles.capability}>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Rows />

      <section id="campo" className={styles.storySection} aria-labelledby="campo-title">
        <div className={styles.frame}>
          <SectionHeading id="campo-title" title="Do talhão ao painel." text="Acompanhe uma captura saindo da fazenda, atravessando uma queda de internet e chegando à matriz." />
        </div>
        <FieldStory />
      </section>

      <section id="painel" className={`${styles.frame} ${styles.section}`} aria-labelledby="panel-title">
        <SectionHeading id="panel-title" title="Da matriz à fazenda." text="Acompanhe o contato dos coletores, a última coleta por fazenda e quais ativos críticos foram observados offline." />
        <TiltIn>
          <DashboardPreview />
        </TiltIn>
      </section>

      <Rows />

      <section id="seguranca" className={`${styles.frame} ${styles.section}`} aria-labelledby="security-title">
        <div className={styles.split}>
          <SectionHeading id="security-title" title="Feito para dados de várias empresas." />
          <ul className={styles.securityList}>
            {security.map((item) => (
              <li key={item.title}>
                <Reveal className={styles.securityItem}>
                  <Check size={18} aria-hidden="true" />
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="planos" className={`${styles.frame} ${styles.section}`} aria-labelledby="plans-title">
        <SectionHeading id="plans-title" title="Comece com um piloto." text="O painel é o mesmo em todos os planos. Escolha pelo número de fazendas e pelo acompanhamento que a sua TI precisa." />
        <ul className={styles.planTeaser}>
          {plans.map((plan) => (
            <li key={plan.id}>
              <Reveal className={styles.planMini}>
                <div data-recommended={plan.recommended || undefined}>
                  {plan.recommended && <p className={styles.planTag}>Recomendado para grupos</p>}
                  <h3>{plan.name}</h3>
                  <p>{plan.audience}</p>
                  <Link href={`/site/cadastro?plano=${plan.id}`} aria-label={`Solicitar acesso ao plano ${plan.name}`}>Solicitar acesso <ArrowUpRight size={16} aria-hidden="true" /></Link>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>
        <Reveal>
          <Link className={styles.inlineLink} href="/site/planos">Comparar planos e etapas de contratação <ArrowRight size={16} aria-hidden="true" /></Link>
        </Reveal>
      </section>

      <section id="duvidas" className={`${styles.frame} ${styles.section}`} aria-labelledby="faq-title">
        <div className={styles.split}>
          <SectionHeading id="faq-title" title="Dúvidas frequentes" />
          <Reveal className={styles.questions}>
            {questions.map(({ title: question, answer }) => (
              <details className={styles.question} key={question}>
                <summary>{question} <ChevronDown size={20} aria-hidden="true" /></summary>
                <p>{answer}</p>
              </details>
            ))}
          </Reveal>
        </div>
      </section>

      <section className={styles.cta} aria-labelledby="cta-title">
        <div className={`${styles.frame} ${styles.ctaInner}`}>
          <ScrollScale>
            <h2 id="cta-title">Leve o Malha<br /><span>para as suas fazendas.</span></h2>
            <div className={styles.heroActions}>
              <Link href="/site/cadastro" className={styles.primaryButton}>Solicitar acesso <ArrowUpRight size={18} aria-hidden="true" /></Link>
              <Link href="/entrar" className={styles.secondaryButton}>Já sou cliente</Link>
            </div>
          </ScrollScale>
        </div>
      </section>
    </>
  );
}
