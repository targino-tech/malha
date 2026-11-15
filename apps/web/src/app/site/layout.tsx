import type { ReactNode } from 'react';
import { SiteFooter } from './_components/site-footer';
import { SiteHeader } from './_components/site-header';
import styles from './site.module.css';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.site}>
      {/* A fonte de títulos chega antes da primeira pintura e evita o salto de largura. */}
      <link rel="preload" href="/malha/barlow-condensed-700.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      <a className={styles.skip} href="#conteudo">Pular para o conteúdo</a>
      <SiteHeader />
      <main id="conteudo" tabIndex={-1}>{children}</main>
      <SiteFooter />
      <div className={styles.grain} aria-hidden="true" />
    </div>
  );
}
