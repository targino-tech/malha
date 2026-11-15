'use client';

import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import Link from 'next/link';
import { useRef } from 'react';
import styles from '../site.module.css';
import { AsciiGlobe } from './ascii-globe';
import { RevealWords } from './reveal';

const ease = [0.16, 1, 0.3, 1] as const;

// Abertura do site: as faixas de letterbox se abrem (CSS, sem depender de JavaScript),
// o globo chega de longe saindo do desfoque e, ao rolar, a câmera avança sobre ele enquanto o título sobe.
export function CinematicHero({ facts }: { facts: ReadonlyArray<readonly [string, string]> }) {
  const reduced = useReducedMotion() ?? false;
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  const globeScale = useTransform(progress, [0, 1], [1, 1.5]);
  const globeY = useTransform(progress, [0, 1], [0, 160]);
  const globeOpacity = useTransform(progress, [0, 0.85], [1, 0.1]);
  const textY = useTransform(progress, [0, 1], [0, -140]);
  const textOpacity = useTransform(progress, [0, 0.6], [1, 0]);
  const stripOpacity = useTransform(progress, [0.25, 0.7], [1, 0]);
  const captionOpacity = useTransform(progress, [0, 0.25], [1, 0]);

  return (
    <section ref={ref} className={styles.hero} aria-labelledby="site-title">
      <div className={styles.heroGrid} aria-hidden="true" />
      <div className={styles.heroVignette} aria-hidden="true" />
      <div className={`${styles.frame} ${styles.heroInner}`}>
        <motion.div className={styles.heroContent} data-malha-reveal style={reduced ? undefined : { y: textY, opacity: textOpacity }}>
          <h1 id="site-title">
            <RevealWords text="A rede do campo," accent="à vista da matriz." delay={0.4} />
          </h1>
          <motion.div
            data-malha-reveal
            initial={reduced ? false : { opacity: 0, y: 16, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, ease, delay: 0.8 }}
          >
            <p className={styles.heroDescription}>
              Coletores, switches e antenas de todas as fazendas do grupo em um só painel. Se uma unidade perde contato, a matriz sabe em 3 minutos.
            </p>
            <div className={styles.heroActions}>
              <Link href="/site/cadastro" className={styles.primaryButton}>Solicitar acesso <ArrowUpRight size={18} aria-hidden="true" /></Link>
              <a className={styles.secondaryButton} href="#campo">Ver como funciona <ArrowDown size={17} aria-hidden="true" /></a>
            </div>
          </motion.div>
        </motion.div>
        <div className={styles.globeStage}>
        <motion.div className={styles.globeWrap} data-malha-reveal style={reduced ? undefined : { scale: globeScale, y: globeY, opacity: globeOpacity }}>
          <motion.div
            className={styles.globeIntro}
            data-malha-reveal
            initial={reduced ? false : { opacity: 0, scale: 0.62, filter: 'blur(18px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            transition={{ duration: 1.8, ease, delay: 0.2 }}
          >
            <AsciiGlobe className={styles.globe} />
          </motion.div>
        </motion.div>
          <motion.p
            className={styles.globeCaption}
            data-malha-reveal
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 1.2 }}
            style={reduced ? undefined : { opacity: captionOpacity }}
          >
            <span>Ilustração</span> Rotas e fazendas de exemplo
          </motion.p>
        </div>
      </div>
      <motion.div className={styles.ticker} style={reduced ? undefined : { opacity: stripOpacity }}>
        <ul className={`${styles.frame} ${styles.tickerTrack}`} aria-label="Dados técnicos do Malha">
          {facts.map(([label, value], index) => (
            <motion.li
              key={label}
              data-malha-reveal
              initial={reduced ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease, delay: 1 + index * 0.05 }}
            >
              <span>{label}</span> <strong>{value}</strong>
            </motion.li>
          ))}
        </ul>
      </motion.div>
      <div className={`${styles.letterbox} ${styles.letterboxTop}`} aria-hidden="true" />
      <div className={`${styles.letterbox} ${styles.letterboxBottom}`} aria-hidden="true" />
    </section>
  );
}
