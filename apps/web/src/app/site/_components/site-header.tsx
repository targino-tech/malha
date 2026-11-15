'use client';

import { ArrowUpRight, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import styles from '../site.module.css';
import { Brand } from './brand';

const links = [
  { href: '/site#produto', label: 'Produto' },
  { href: '/site#campo', label: 'Como funciona' },
  { href: '/site#painel', label: 'Painel' },
  { href: '/site/planos', label: 'Planos' },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    navRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className={styles.header} data-scrolled={scrolled || open}>
      <div className={styles.headerInner}>
        <Brand />
        <nav ref={navRef} aria-label="Navegação do site" className={styles.nav} id="site-menu" data-open={open}>
          {links.map((link) => (
            <Link key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined} onClick={() => setOpen(false)}>
              {link.label}
            </Link>
          ))}
          <Link className={styles.navMobileOnly} href="/entrar" onClick={() => setOpen(false)}>Entrar</Link>
        </nav>
        <div className={styles.headerActions}>
          <Link className={styles.textLink} href="/entrar">Entrar</Link>
          {pathname !== '/site/cadastro' && (
            <Link className={styles.primaryButton} href="/site/cadastro">
              Solicitar acesso <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          )}
          <button
            type="button"
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label={open ? 'Fechar menu' : 'Abrir menu'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
  );
}
