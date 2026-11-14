import { ArrowRight, Network } from 'lucide-react';

export default function LoginPage() {
  return (
    <main className="standalone">
      <div className="brand-icon"><Network size={22} aria-hidden="true" /></div>
      <h1>Entre no Malha</h1>
      <p>Use a conta corporativa para acessar o painel das suas fazendas.</p>
      <a href="/api/auth/login" className="button primary">Entrar com Microsoft <ArrowRight size={17} aria-hidden="true" /></a>
    </main>
  );
}
