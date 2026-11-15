import Link from 'next/link';
import styles from '../site.module.css';

// Símbolo do Malha: uma folha cuja nervura é uma rede. A nervura central leva os dados
// da semente (o coletor, em trigo) até a ponta; os ramos terminam em nós, como os ativos de cada fazenda.
export function BrandMark({ size = 34, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={styles.brandMark} data-animated={animated || undefined}>
      <g className={styles.brandLeaf}>
        <path d="M11 53C11 27.5 27.5 11 53 11c0 25.5-16.5 42-42 42Z" fill="#b6f37a" />
        <path d="M11 53C11 27.5 27.5 11 53 11L11 53Z" fill="#9fdc63" />
      </g>
      <g stroke="#060a07" strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path className={styles.brandVein} d="M17 47 45 19" pathLength={1} />
        <path className={styles.brandBranch} d="M24.5 39.5 22 30M32 32l9.5 2.5M38.5 25.5 36 17" />
      </g>
      <g className={styles.brandNodes} fill="#060a07">
        <circle cx="22" cy="30" r="2.9" /><circle cx="41.5" cy="34.5" r="2.9" /><circle cx="36" cy="17" r="2.4" />
      </g>
      <circle cx="11" cy="53" r="4.6" fill="#d9b866" stroke="#060a07" strokeWidth="1.6" />
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
