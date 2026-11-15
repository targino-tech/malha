'use client';

import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { useRef, type ReactNode } from 'react';

const ease = [0.16, 0.84, 0.3, 1] as const;

// O estado inicial mantém o conteúdo legível caso o JavaScript não carregue.
export function Reveal({ children, className, priority = false, delay = 0 }: {
  children: ReactNode;
  className?: string;
  priority?: boolean;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  const initial = reduced ? false : { opacity: 0.5, y: priority ? 12 : 18 };
  const visible = { opacity: 1, y: 0 };

  return (
    <motion.div
      className={className}
      data-malha-reveal
      initial={initial}
      animate={priority ? visible : undefined}
      whileInView={priority ? undefined : visible}
      viewport={{ once: true, amount: 0.18 }}
      transition={{ duration: 0.6, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

export function RevealWords({ text, className, accent, delay = 0.1 }: { text: string; className?: string; accent?: string; delay?: number }) {
  const reduced = useReducedMotion();
  const words = text.split(' ');
  const accentWords = accent ? accent.split(' ') : [];
  const render = (word: string, index: number, highlighted: boolean) => (
    <motion.span
      key={`${word}-${index}-${highlighted}`}
      style={{ display: 'inline-block', whiteSpace: 'pre' }}
      data-accent={highlighted || undefined}
      data-malha-reveal
      initial={reduced ? false : { y: '0.4em', opacity: 0.2, filter: 'blur(10px)' }}
      animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.65, ease, delay: delay + index * 0.06 }}
    >
      {word}{' '}
    </motion.span>
  );
  return (
    <span className={className}>
      {words.map((word, index) => render(word, index, false))}
      {accentWords.length > 0 && <br />}
      {accentWords.map((word, index) => render(word, words.length + index, true))}
    </span>
  );
}

// Título de seção: entra como letreiro, saindo do desfoque, e uma linha de trigo se desenha embaixo.
export function SceneTitle({ id, title, text, className }: { id: string; title: string; text?: string; className?: string }) {
  const reduced = useReducedMotion();
  const hidden = reduced ? false : { opacity: 0.4, y: 16, filter: 'blur(4px)' };
  const shown = { opacity: 1, y: 0, filter: 'blur(0px)' };
  return (
    <div className={className}>
      <motion.h2 id={id} data-malha-reveal initial={hidden} whileInView={shown} viewport={{ once: true, amount: 0.6 }} transition={{ duration: 0.55, ease }}>
        {title}
      </motion.h2>
      <motion.span
        aria-hidden="true"
        data-scene-rule
        data-malha-reveal
        initial={reduced ? false : { scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 0.5, ease, delay: 0.15 }}
      />
      {text && (
        <motion.p data-malha-reveal initial={reduced ? false : { opacity: 0.5, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.6 }} transition={{ duration: 0.5, ease, delay: 0.1 }}>
          {text}
        </motion.p>
      )}
    </div>
  );
}

// Plano de revelação: o conteúdo chega inclinado em perspectiva e se endireita enquanto entra na tela.
export function TiltIn({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'center center'] });
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 28, mass: 0.5 });
  // Com movimento reduzido as faixas de saída já começam no estado final; o estilo nunca é removido.
  const rotateX = useTransform(p, [0, 1], reduced ? [0, 0] : [28, 0]);
  const scale = useTransform(p, [0, 1], reduced ? [1, 1] : [0.86, 1]);
  const y = useTransform(p, [0, 1], reduced ? [0, 0] : [90, 0]);
  const opacity = useTransform(p, [0, 0.6], reduced ? [1, 1] : [0.35, 1]);
  return (
    <div ref={ref} className={className} style={{ perspective: 1400 }}>
      <motion.div data-malha-reveal style={{ rotateX, scale, y, opacity, transformOrigin: '50% 100%' }}>{children}</motion.div>
    </div>
  );
}

// Encerramento: o bloco cresce e ganha nitidez conforme se aproxima do centro da tela.
export function ScrollScale({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'center center'] });
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const scale = useTransform(p, [0, 1], reduced ? [1, 1] : [0.82, 1]);
  const opacity = useTransform(p, [0, 1], reduced ? [1, 1] : [0.25, 1]);
  const letterSpacing = useTransform(p, [0, 1], reduced ? ['-0.01em', '-0.01em'] : ['0.06em', '-0.01em']);
  return (
    <motion.div ref={ref} className={className} data-malha-reveal style={{ scale, opacity, letterSpacing }}>
      {children}
    </motion.div>
  );
}
