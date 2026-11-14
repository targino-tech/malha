import { redirect } from 'next/navigation';
import { Dashboard } from '../components/dashboard/dashboard';
import { getDashboard } from '../server/dashboard';
import { HttpError } from '../server/http';

export const dynamic = 'force-dynamic';

async function loadDashboard() {
  try {
    return await getDashboard();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      redirect('/entrar');
    }
    if (error instanceof HttpError && error.status === 403) return null;
    throw error;
  }
}

export default async function Page() {
  const initialData = await loadDashboard();
  if (!initialData) {
    return (
      <main className="standalone">
        <h1>Acesso não habilitado</h1>
        <p>Peça ao administrador para verificar sua associação no Malha.</p>
      </main>
    );
  }
  return <Dashboard initialData={initialData} />;
}
