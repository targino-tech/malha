import Link from 'next/link';
import styles from '../site.module.css';

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={styles.brandMark}>
      <rect x=".75" y=".75" width="62.5" height="62.5" rx="13.25" fill="#060a07" stroke="#24402b" strokeWidth="1.5" />
      <path d="M15 46V18l17 17 17-17v28" fill="none" stroke="#b6f37a" strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M15 46h34M32 35v11" fill="none" stroke="#3f6b47" strokeWidth="1.6" strokeLinecap="round" />
      <g fill="#e6ffd0"><circle cx="15" cy="18" r="3.6" /><circle cx="49" cy="18" r="3.6" /><circle cx="32" cy="35" r="3.6" /><circle cx="15" cy="46" r="3.6" /><circle cx="49" cy="46" r="3.6" /></g>
    </svg>
  );
}

export function Brand() {
  return (
    <Link className={styles.brand} href="/site" aria-label="Malha, página inicial">
      <BrandMark />
      <span>malha<span>.</span></span>
    </Link>
  );
}
