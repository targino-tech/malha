import type { ReactNode } from 'react';
import { SiteFooter } from './_components/site-footer';
import { SiteHeader } from './_components/site-header';
import styles from './site.module.css';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#conteudo">Pular para o conteúdo</a>
      <SiteHeader />
      <main id="conteudo" tabIndex={-1}>{children}</main>
      <SiteFooter />
      <div className={styles.grain} aria-hidden="true" />
    </div>
  );
}
