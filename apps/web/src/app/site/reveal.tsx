'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

const transition = { duration: 0.58, ease: [0.2, 0.65, 0.3, 1] as const };

export function Reveal({ children, className, priority = false }: {
  children: ReactNode;
  className?: string;
  priority?: boolean;
}) {
  const initial = { opacity: 0.9, y: priority ? 16 : 24 };
  const visible = { opacity: 1, y: 0 };

  return (
    <motion.div
      className={className}
      data-malha-reveal
      initial={initial}
      animate={priority ? visible : undefined}
      whileInView={priority ? undefined : visible}
      viewport={{ once: true, amount: 0.18 }}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}
