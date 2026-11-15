import { BrandMark } from './site/_components/brand';

export default function Loading() {
  return (
    <main className="standalone" aria-busy="true" aria-live="polite">
      <div className="brand-icon"><BrandMark size={44} /></div>
      <h1>Carregando o Malha</h1>
      <p>Buscando fazendas e dados do inventário.</p>
    </main>
  );
}
