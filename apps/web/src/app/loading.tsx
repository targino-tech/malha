import { Network } from 'lucide-react';

export default function Loading() {
  return (
    <main className="standalone" aria-busy="true" aria-live="polite">
      <div className="brand-icon"><Network size={22} aria-hidden="true" /></div>
      <h1>Carregando o Malha</h1>
      <p>Buscando fazendas e dados do inventário.</p>
    </main>
  );
}
