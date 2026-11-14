'use client';

import { CircleAlert } from 'lucide-react';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone">
      <CircleAlert size={28} aria-hidden="true" />
      <h1>O painel está indisponível</h1>
      <p>Tente carregar os dados novamente.</p>
      <button className="button primary" type="button" onClick={reset}>Tentar novamente</button>
    </main>
  );
}
