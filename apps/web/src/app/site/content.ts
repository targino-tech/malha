import type { PlanId } from '@/server/site-requests';

// Recursos já entregues no MVP. Atualize esta lista quando um recurso novo for lançado.
export const capabilities = [
  { code: 'UNF', title: 'Coleta UniFi em leitura', text: 'O coletor consulta sites e equipamentos adotados pela API local oficial, só com GET. Nada é alterado na sua rede.' },
  { code: 'INV', title: 'Inventário por fazenda', text: 'Pesquise por nome, etiqueta, IP ou MAC. Cada ativo mostra a origem do registro e a última observação.' },
  { code: 'CSV', title: 'Importação com prévia', text: 'Envie a planilha que você já tem. O Malha valida linha a linha e só importa depois da sua confirmação.' },
  { code: 'OCR', title: 'Ocorrências com contexto', text: 'Coletor sem contato, coleta desatualizada, ativo crítico offline e divergência de inventário, uma por recurso.' },
  { code: 'MAIL', title: 'Alerta crítico por e-mail', text: 'Ocorrências críticas chegam agrupadas por fazenda, sem repetição, para os destinatários do seu grupo.' },
  { code: 'WAN', title: 'Resistente à queda de WAN', text: 'Sem internet, o coletor guarda os lotes localmente e retoma o envio na reconexão, sem duplicar capturas.' },
];

export const facts = [
  ['Sinal do coletor', 'a cada 60 s'],
  ['Leitura do inventário', 'a cada 5 min'],
  ['Alerta sem contato', 'após 3 min'],
  ['Assinatura das mensagens', 'Ed25519'],
  ['Acesso à console UniFi', 'somente leitura'],
  ['Importação CSV', 'até 10 mil linhas'],
] as const;

export const security = [
  { title: 'Cada grupo vê só o que é seu', text: 'Rotas, consultas e painéis são filtrados pelo grupo e pela fazenda, com isolamento no próprio PostgreSQL.' },
  { title: 'Login corporativo com MFA', text: 'O acesso ao painel usa o Microsoft Entra ID do seu grupo. Quem sai do diretório perde o acesso.' },
  { title: 'Coletor que não altera nada', text: 'A chave da integração UniFi é usada só para leitura. Todas as conexões partem da fazenda para o Malha.' },
  { title: 'Mensagens assinadas', text: 'Heartbeat e lotes são assinados no coletor e verificados na chegada. Reenvios mantêm a mesma identidade.' },
];

export const questions = [
  {
    title: 'O que o coletor consulta no UniFi?',
    answer: 'O coletor consulta sites e equipamentos adotados em modo de leitura. O painel reúne identificação, estado reportado e última observação. A compatibilidade da API local é verificada na configuração do piloto.',
  },
  {
    title: 'O que aparece quando uma fazenda perde a conexão?',
    answer: 'Após 3 minutos sem sinal, o painel abre uma ocorrência de coletor sem contato e preserva a data da última observação recebida. O coletor guarda as capturas localmente enquanto aguarda a volta da conexão.',
  },
  {
    title: 'Posso usar o inventário que já tenho em planilha?',
    answer: 'Sim. Use um arquivo CSV em UTF-8 com etiqueta, nome e categoria. O Malha permite visualizar os registros e corrigir inconsistências antes de confirmar a importação.',
  },
  {
    title: 'Como funciona a contratação?',
    answer: 'Você envia o cadastro pelo site, a equipe agenda uma conversa técnica e envia a proposta. Depois, configuramos o diretório do seu grupo, as fazendas e um código de ativação de uso único para cada coletor.',
  },
];

// Termos comerciais: defina limites e valores antes de divulgar. Os recursos listados já existem no produto.
export const plans: Array<{ id: PlanId; name: string; tagline: string; audience: string; featured?: boolean; items: string[] }> = [
  {
    id: 'piloto',
    name: 'Piloto',
    tagline: 'Para validar o Malha em campo.',
    audience: 'Indicado para 1 a 3 fazendas',
    items: [
      'Coletor UniFi em cada fazenda',
      'Inventário e importação CSV',
      'Ocorrências e alerta crítico por e-mail',
      'Homologação da console UniFi da unidade',
    ],
  },
  {
    id: 'grupo',
    name: 'Grupo',
    tagline: 'Para grupos com várias unidades.',
    audience: 'Indicado para 4 a 30 fazendas',
    featured: true,
    items: [
      'Tudo do Piloto',
      'Login pelo Microsoft Entra ID do grupo',
      'Papéis de administração, TI e diretoria',
      'Destinatários de alerta por grupo',
    ],
  },
  {
    id: 'corporativo',
    name: 'Corporativo',
    tagline: 'Para operações de grande porte.',
    audience: 'Indicado para mais de 30 fazendas',
    items: [
      'Tudo do Grupo',
      'Dimensionamento de retenção e fila local',
      'Ensaio de 24 h sem WAN por unidade',
      'Acompanhamento técnico na implantação',
    ],
  },
];

export const onboarding = [
  { title: 'Cadastro', text: 'Conte quantas fazendas e qual plano interessa. Leva um minuto.' },
  { title: 'Conversa técnica', text: 'Revisamos a console UniFi de cada unidade e enviamos a proposta.' },
  { title: 'Configuração', text: 'Conectamos o diretório do grupo e geramos um código de ativação de uso único para cada coletor.' },
  { title: 'Acesso ao painel', text: 'Sua equipe entra pelo portal com a conta corporativa e acompanha as fazendas.' },
];
