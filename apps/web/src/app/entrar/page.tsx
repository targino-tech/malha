import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import { AsciiGlobe } from '../site/_components/ascii-globe';
import { Brand } from '../site/_components/brand';
import styles from '../site/site.module.css';

export const metadata: Metadata = { title: 'Portal do cliente | Malha', description: 'Acesse o painel das fazendas do seu grupo.' };

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
            <h1>Entre no Malha</h1>
            <p>Use a conta corporativa do seu grupo para acessar o painel das fazendas.</p>
            <a href="/api/auth/login" className={styles.primaryButton}>Entrar com Microsoft <ArrowRight size={17} aria-hidden="true" /></a>
            <p className={styles.portalNote}><ShieldCheck size={16} aria-hidden="true" /> O acesso é liberado pelo administrador do seu grupo no Malha.</p>
            <details className={styles.portalHelp}>
              <summary>Não consegue entrar?</summary>
              <ul>
                <li>Use a conta do diretório Microsoft da empresa, não uma conta pessoal.</li>
                <li>Se aparecer &quot;Acesso não habilitado&quot;, peça ao administrador do grupo para incluir seu usuário no Malha.</li>
                <li>A sessão expira após 30 minutos sem uso. Entre de novo para continuar.</li>
              </ul>
            </details>
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
