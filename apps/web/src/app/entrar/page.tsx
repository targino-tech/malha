import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import { AsciiGlobe } from '../site/_components/ascii-globe';
import { Brand } from '../site/_components/brand';
import { oidcProvider } from '@/server/oidc';
import styles from '../site/site.module.css';

export const metadata: Metadata = { title: 'Portal do cliente | Malha', description: 'Acesse o painel das fazendas do seu grupo.' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  provedor: 'O provedor de login não confirmou a entrada. Tente de novo.',
  credenciais: 'Usuário ou senha inválidos. Confira o domínio e tente de novo.',
  'sem-acesso': 'Sua conta existe no diretório, mas não está habilitada no Malha. Peça ao administrador do grupo.',
  tentativas: 'Muitas tentativas seguidas. Aguarde 15 minutos e tente de novo.',
  campos: 'Informe domínio, usuário e senha.',
  indisponivel: 'O login pelo diretório está indisponível agora. Tente pelo Microsoft ou fale com a TI.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  const error = erro && Object.hasOwn(ERRORS, erro) ? ERRORS[erro as keyof typeof ERRORS] : undefined;
  // Sem o Entra configurado (grupo só com AD/LDAP), o botão Microsoft levaria a um erro: fica oculto.
  const entra = process.env.MALHA_MODE === 'demo' || Boolean(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET);
  const provider = oidcProvider();
  return (
    <div className={styles.site}>
      <main className={styles.portal}>
        <div className={styles.portalArt}>
          <AsciiGlobe className={styles.globe} scene="world" />
          <p className={styles.portalCaption}><span>Ilustração</span> Rotas de exemplo</p>
        </div>
        <div className={styles.portalPanel}>
          <Brand />
          <div className={styles.portalCard}>
            <h1>Entre no Malha</h1>
            <p>Use a conta corporativa do seu grupo para acessar o painel das fazendas.</p>
            {provider && <a href="/api/auth/oidc/login" className={entra ? styles.secondaryButton : styles.primaryButton}>Entrar com {provider.name} <ArrowRight size={17} aria-hidden="true" /></a>}
            {entra && (
              <>
                <a href="/api/auth/login" className={styles.primaryButton}>Entrar com Microsoft <ArrowRight size={17} aria-hidden="true" /></a>
                <div className={styles.portalDivider}><span>ou com a conta da rede (Active Directory / LDAP)</span></div>
              </>
            )}
            {error && <p className={styles.formError} role="alert">{error}</p>}
            <form className={styles.portalForm} method="post" action="/api/auth/ldap">
              <label className={styles.field}><span>Domínio da empresa</span><input name="domain" autoComplete="organization" placeholder="grupo.local" required maxLength={253} /></label>
              <label className={styles.field}><span>Usuário</span><input name="username" autoComplete="username" placeholder="nome.sobrenome" required maxLength={256} /></label>
              <label className={styles.field}><span>Senha</span><input name="password" type="password" autoComplete="current-password" required maxLength={512} /></label>
              <button type="submit" className={styles.secondaryButton}>Entrar com a conta da rede <ArrowRight size={17} aria-hidden="true" /></button>
            </form>
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
