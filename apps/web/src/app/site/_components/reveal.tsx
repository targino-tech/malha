'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

const ease = [0.16, 0.84, 0.3, 1] as const;

// O estado inicial mantém o conteúdo legível caso o JavaScript não carregue.
export function Reveal({ children, className, priority = false, delay = 0 }: {
  children: ReactNode;
  className?: string;
  priority?: boolean;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  const initial = reduced ? false : { opacity: 0.35, y: priority ? 18 : 32, filter: 'blur(6px)' };
  const visible = { opacity: 1, y: 0, filter: 'blur(0px)' };

  return (
    <motion.div
      className={className}
      data-malha-reveal
      initial={initial}
      animate={priority ? visible : undefined}
      whileInView={priority ? undefined : visible}
      viewport={{ once: true, amount: 0.18 }}
      transition={{ duration: 0.8, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

export function RevealWords({ text, className, accent }: { text: string; className?: string; accent?: string }) {
  const reduced = useReducedMotion();
  const words = text.split(' ');
  const accentWords = accent ? accent.split(' ') : [];
  const render = (word: string, index: number, highlighted: boolean) => (
    <motion.span
      key={`${word}-${index}-${highlighted}`}
      style={{ display: 'inline-block', whiteSpace: 'pre' }}
      data-accent={highlighted || undefined}
      initial={reduced ? false : { y: '0.35em', opacity: 0.3, filter: 'blur(10px)' }}
      animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.9, ease, delay: 0.1 + index * 0.06 }}
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
