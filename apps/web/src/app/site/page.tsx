import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowDown, ArrowRight, ArrowUpRight, ChevronDown, Database, Radio, Rows3 } from 'lucide-react';
import { DashboardPreview } from './dashboard-preview';
import { Reveal } from './reveal';
import styles from './site.module.css';

const title = 'Malha | Inventário de rede e ativos para fazendas';
const description = 'Acompanhe ativos, coletores e equipamentos de rede de várias fazendas no mesmo painel. Integre UniFi ou importe seu inventário em CSV.';

export const metadata: Metadata = {
  title,
  description,
  robots: { index: true, follow: true },
  openGraph: { type: 'website', locale: 'pt_BR', siteName: 'Malha', title, description },
};

const capabilities = [
  {
    icon: Radio,
    title: 'Coleta UniFi em leitura',
    description: 'Consulte equipamentos adotados pela API local. Se a internet cair, o coletor guarda as observações e retoma o envio na reconexão.',
  },
  {
    icon: Rows3,
    title: 'Inventário por fazenda',
    description: 'Encontre equipamentos por unidade, nome, etiqueta, IP ou MAC. Consulte a origem e o horário da última observação.',
  },
  {
    icon: Database,
    title: 'Importação CSV com prévia',
    description: 'Selecione a fazenda, valide o arquivo e corrija erros por linha antes de confirmar a importação do seu inventário.',
  },
];

const questions = [
  {
    title: 'O que o coletor consulta no UniFi?',
    answer: 'O coletor consulta sites e equipamentos adotados em modo de leitura. O painel reúne identificação, estado reportado e última observação. Consulte a compatibilidade da API local durante a configuração do piloto.',
  },
  {
    title: 'O que aparece quando uma fazenda perde a conexão?',
    answer: 'O painel sinaliza a ausência do coletor e preserva a data da última observação recebida. O coletor guarda as capturas localmente enquanto aguarda a volta da conexão.',
  },
  {
    title: 'Posso usar o inventário que já tenho em planilha?',
    answer: 'Sim. Use um arquivo CSV em UTF-8 com etiqueta, nome e categoria. O Malha permite visualizar os registros e corrigir inconsistências antes de confirmar a importação.',
  },
];

function Brand() {
  return (
    <Link className={styles.brand} href="/site" aria-label="Malha, página inicial">
      <Image src="/malha/malha-mark.svg" width={33} height={33} alt="" unoptimized />
      <span>malha<span>.</span></span>
    </Link>
  );
}

function PanelLink({ quiet = false }: { quiet?: boolean }) {
  return (
    <Link href="/" className={quiet ? styles.secondaryButton : styles.primaryButton}>
      Abrir painel <ArrowUpRight size={18} aria-hidden="true" />
    </Link>
  );
}

export default function SitePage() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#conteudo">Pular para o conteúdo</a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Brand />
          <nav aria-label="Navegação do site" className={styles.nav}>
            <a href="#painel">Painel</a>
            <a href="#recursos">Recursos</a>
            <a href="#duvidas">Dúvidas</a>
          </nav>
          <PanelLink quiet />
        </div>
      </header>

      <main id="conteudo" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="site-title">
          <Image className={styles.heroPhoto} src="/malha/campo.webp" fill preload sizes="100vw" alt="" unoptimized />
          <div className={styles.heroShade} />
          <div className={styles.frame}>
            <Reveal className={styles.heroContent} priority>
              <p className={styles.eyebrow}>Infraestrutura para o agro de Mato Grosso</p>
              <h1 id="site-title">A rede do campo,<br /><span>à vista.</span></h1>
              <p className={styles.heroDescription}>Acompanhe coletores e equipamentos de várias fazendas em um só painel.</p>
              <div className={styles.heroActions}>
                <PanelLink />
                <a className={styles.heroResourceLink} href="#recursos">Conhecer os recursos <ArrowDown size={17} aria-hidden="true" /></a>
              </div>
            </Reveal>
          </div>
        </section>

        <section id="painel" className={`${styles.frame} ${styles.panelSection}`} aria-labelledby="panel-title">
          <Reveal className={styles.sectionHeading}>
            <h2 id="panel-title">Da matriz à fazenda.</h2>
            <p>Acompanhe o contato dos coletores, a última coleta por fazenda e quais ativos críticos foram observados offline.</p>
          </Reveal>
          <Reveal>
            <DashboardPreview />
          </Reveal>
        </section>

        <section id="recursos" className={`${styles.frame} ${styles.resourceSection}`} aria-labelledby="resource-title">
          <Reveal className={styles.sectionHeading}>
            <h2 id="resource-title">O que o Malha reúne</h2>
          </Reveal>
          <Reveal className={styles.resourceList}>
            {capabilities.map(({ icon: Icon, title, description }) => (
              <article className={styles.resource} key={title}>
                <Icon size={28} strokeWidth={1.5} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </Reveal>
        </section>

        <section id="duvidas" className={`${styles.frame} ${styles.faqSection}`} aria-labelledby="faq-title">
          <Reveal>
            <h2 id="faq-title">Dúvidas frequentes</h2>
            <div className={styles.questions}>
              {questions.map(({ title, answer }) => (
                <details className={styles.question} key={title}>
                  <summary>{title} <ChevronDown size={20} aria-hidden="true" /></summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.frame} ${styles.footerInner}`}>
          <Brand />
          <Link href="/" className={styles.footerLink}>Acessar o Malha <ArrowRight size={17} aria-hidden="true" /></Link>
        </div>
      </footer>
    </div>
  );
}
