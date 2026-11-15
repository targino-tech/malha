import Link from 'next/link';
import styles from '../site.module.css';

// Símbolo do Malha: uma folha cuja nervura é uma rede. A nervura leva os dados do grão de trigo
// (a fazenda) até a ponta; os ramos terminam em nós quadrados, a mesma linguagem do ■ usado no site.
// Para fundo claro, use public/malha/malha-mark-light.svg.
export function BrandMark({ size = 34, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={styles.brandMark} data-animated={animated || undefined}>
      <g className={styles.brandLeaf}>
        <path d="M8 56C8 27 27 8 56 8c0 29-19 48-48 48Z" fill="#b6f37a" />
        <path d="M8 56C8 27 27 8 56 8L8 56Z" fill="#9fdc63" />
      </g>
      <g stroke="#060a07" strokeWidth="3.4" strokeLinecap="square" fill="none">
        <path className={styles.brandVein} d="M15 49 45 19" pathLength={1} />
        <path className={styles.brandBranch} d="M25 39V27M33 31h12" />
      </g>
      <g className={styles.brandNodes} fill="#060a07">
        <rect x="21.5" y="22" width="7" height="7" rx="1" /><rect x="42" y="27.5" width="7" height="7" rx="1" /><rect x="42.5" y="13.5" width="7" height="7" rx="1" />
      </g>
      <g transform="rotate(-45 10 54)">
        <ellipse cx="10" cy="54" rx="7.5" ry="3.9" fill="#d9b866" stroke="#060a07" strokeWidth="1.6" />
        <path d="M4.5 54h11" stroke="#8a6f2c" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function Brand({ animated = false }: { animated?: boolean }) {
  return (
    <Link className={styles.brand} href="/site" aria-label="Malha, página inicial">
      <BrandMark animated={animated} />
      <span>malha<span className={styles.brandNode} /></span>
    </Link>
  );
}
