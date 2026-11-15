import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import { AsciiGlobe } from '../site/_components/ascii-globe';
import { Brand } from '../site/_components/brand';
import styles from '../site/site.module.css';

export const metadata: Metadata = { title: 'Portal do cliente | Malha' };

export default function LoginPage() {
  return (
    <div className={styles.site}>
      <main className={styles.portal}>
        <div className={styles.portalArt} aria-hidden="true">
          <AsciiGlobe className={styles.globe} />
        </div>
        <div className={styles.portalPanel}>
          <Brand />
          <div className={styles.portalCard}>
            <p className={styles.eyebrow}><span className={styles.liveDot} /> Portal do cliente</p>
            <h1>Entre no Malha</h1>
            <p>Use a conta corporativa do seu grupo para acessar o painel das fazendas.</p>
            <a href="/api/auth/login" className={styles.primaryButton}>Entrar com Microsoft <ArrowRight size={17} aria-hidden="true" /></a>
            <p className={styles.portalNote}><ShieldCheck size={16} aria-hidden="true" /> O acesso é liberado pelo administrador do seu grupo no Malha.</p>
          </div>
          <div className={styles.portalLinks}>
            <Link href="/site/cadastro">Ainda não é cliente? Solicite acesso</Link>
            <Link href="/site"><ArrowLeft size={15} aria-hidden="true" /> Voltar ao site</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
