import Link from 'next/link';
import { REPOSITORY_URL } from '../content';
import styles from '../site.module.css';
import { Brand } from './brand';

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`${styles.frame} ${styles.footerInner}`}>
        <div className={styles.footerBrand}>
          <Brand />
          <p>Inventário e coleta de rede para grupos agrícolas com várias fazendas.</p>
        </div>
        <nav aria-label="Rodapé" className={styles.footerNav}>
          <div>
            <p>Produto</p>
            <Link href="/site#produto">Recursos</Link>
            <Link href="/site#campo">Como funciona</Link>
            <Link href="/site#seguranca">Segurança</Link>
          </div>
          <div>
            <p>Open source</p>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">Código-fonte</a>
            <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">Licença AGPL-3.0</a>
            <Link href="/site/cadastro">Apoio na implantação</Link>
            <Link href="/site/privacidade">Privacidade</Link>
          </div>
          <div>
            <p>Clientes</p>
            <Link href="/entrar">Portal do cliente</Link>
          </div>
        </nav>
      </div>
      <div className={`${styles.frame} ${styles.footerBase}`}>
        <span>© {new Date().getFullYear()} Malha · Software livre sob a <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">AGPL-3.0</a></span>
        <span className={styles.mono}>-12.55, -55.71 · Mato Grosso</span>
      </div>
    </footer>
  );
}
