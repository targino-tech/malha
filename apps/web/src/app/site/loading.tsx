import styles from './site.module.css';

// Tela de espera do site: o mesmo preto da abertura, sem a tela clara do painel.
export default function SiteLoading() {
  return <div className={styles.siteLoading} aria-busy="true" aria-label="Carregando o site do Malha" />;
}
