import type { Metadata } from 'next';
import styles from '../site.module.css';

export const metadata: Metadata = {
  title: 'Privacidade | Malha',
  description: 'Como o Malha usa os dados enviados pelo formulário de cadastro do site.',
  robots: { index: true, follow: true },
};

// Descreve o tratamento implementado em apps/web/src/server/site-requests.ts. Revise com o jurídico antes de publicar.
const sections = [
  {
    title: 'O que coletamos',
    text: 'Nome, e-mail corporativo, empresa ou grupo, número de fazendas, plano de interesse e a mensagem opcional que você escrever no formulário de cadastro.',
  },
  {
    title: 'Para que usamos',
    text: 'Somente para responder à sua solicitação, agendar a conversa técnica e preparar a proposta. Não enviamos newsletter nem vendemos ou repassamos os dados.',
  },
  {
    title: 'Proteção contra abuso',
    text: 'Para limitar envios repetidos, guardamos uma assinatura irreversível derivada do endereço de rede da conexão. O endereço em si não é armazenado.',
  },
  {
    title: 'Quem acessa',
    text: 'A equipe do Malha responsável pela contratação. As solicitações ficam separadas dos dados das fazendas dos clientes.',
  },
  {
    title: 'Seus direitos',
    text: 'Você pode pedir acesso, correção ou exclusão dos seus dados respondendo ao e-mail que a equipe enviar, conforme a Lei Geral de Proteção de Dados (Lei 13.709/2018).',
  },
];

export default function PrivacyPage() {
  return (
    <section className={`${styles.frame} ${styles.pageHero} ${styles.prose}`} aria-labelledby="privacy-title">
      <h1 id="privacy-title">Privacidade<br /><span>no cadastro.</span></h1>
      <p className={styles.heroDescription}>Esta página explica o que acontece com os dados enviados pelo formulário de cadastro do site.</p>
      <dl className={styles.privacyList}>
        {sections.map((item) => (
          <div key={item.title}>
            <dt>{item.title}</dt>
            <dd>{item.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
