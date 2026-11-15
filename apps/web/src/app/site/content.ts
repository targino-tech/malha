import type { PlanId } from '@/server/site-requests';

// Recursos já entregues no MVP. Atualize esta lista quando um recurso novo for lançado.
export const capabilities = [
  { title: 'Coleta UniFi em leitura', text: 'O coletor consulta a console UniFi pela API local oficial, somente em leitura. Nada é alterado na sua rede.' },
  { title: 'Inventário por fazenda', text: 'Pesquise por nome, etiqueta, IP ou MAC. Cada ativo mostra a origem do registro e a última observação.' },
  { title: 'Importação com prévia', text: 'Envie a planilha que você já tem. O Malha valida linha a linha e só importa depois da sua confirmação.' },
  { title: 'Ocorrências com contexto', text: 'Coletor sem contato, coleta desatualizada, ativo crítico offline e divergência de inventário, uma por recurso.' },
  { title: 'Alerta crítico por e-mail', text: 'Ocorrências críticas chegam agrupadas por fazenda, sem repetição, para os destinatários do seu grupo.' },
  { title: 'Resistente à queda de WAN', text: 'Sem internet, o coletor guarda os lotes localmente e retoma o envio na reconexão, sem duplicar capturas.' },
];

export const facts = [
  ['Alerta de fazenda sem contato', 'em 3 min'],
  ['Sinal de cada coletor', 'a cada 60 s'],
  ['Inventário atualizado', 'a cada 5 min'],
  ['Acesso à console UniFi', 'somente leitura'],
  ['Mensagens assinadas', 'Ed25519'],
  ['Planilha de inventário', 'até 10 mil linhas'],
] as const;

export const security = [
  { title: 'Cada grupo vê só o que é seu', text: 'Rotas, consultas e painéis são filtrados pelo grupo e pela fazenda, com isolamento aplicado no próprio banco de dados.' },
  { title: 'Login corporativo com MFA', text: 'O acesso ao painel usa o Microsoft Entra ID do seu grupo. Quem sai do diretório perde o acesso.' },
  { title: 'Coletor que não altera nada', text: 'A chave da integração UniFi é usada só para leitura. Todas as conexões partem da fazenda para o Malha.' },
  { title: 'Mensagens assinadas', text: 'Tudo o que o coletor envia sai assinado (Ed25519) e é verificado na chegada. Um reenvio nunca duplica dados.' },
];

export const questions = [
  {
    title: 'O que é o coletor e quem instala?',
    answer: 'É um programa leve que roda como serviço em um computador Linux da fazenda, na mesma rede da console UniFi. Ele só lê a console e inicia todas as conexões até o Malha; sem internet, guarda até 72 horas de capturas. A instalação é feita com a TI da fazenda durante a configuração, com um código de ativação de uso único.',
  },
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

// Termos comerciais: rascunho. Ajuste faixas e serviços antes de divulgar.
// O painel é o mesmo em todos os planos; os planos diferem no porte e no acompanhamento da implantação.
export const plans: Array<{ id: PlanId; name: string; tagline: string; audience: string; min: number; max: number; recommended?: boolean; items: string[] }> = [
  {
    id: 'piloto',
    name: 'Piloto',
    tagline: 'Para validar o Malha em campo.',
    audience: 'Indicado para 1 a 3 fazendas',
    min: 1,
    max: 3,
    items: [
      'Homologação da console UniFi de cada unidade',
      'Ativação assistida do primeiro coletor',
      'Importação inicial do inventário em CSV',
    ],
  },
  {
    id: 'grupo',
    name: 'Grupo',
    tagline: 'Para grupos com várias unidades.',
    audience: 'Indicado para 4 a 30 fazendas',
    min: 4,
    max: 30,
    recommended: true,
    items: [
      'Tudo do Piloto',
      'Ativação dos coletores por lote de fazendas',
      'Configuração dos papéis de TI e diretoria',
    ],
  },
  {
    id: 'corporativo',
    name: 'Corporativo',
    tagline: 'Para operações de grande porte.',
    audience: 'Indicado para mais de 30 fazendas',
    min: 31,
    max: 500,
    items: [
      'Tudo do Grupo',
      'Dimensionamento de retenção e fila local',
      'Ensaio de 24 h sem internet por unidade',
    ],
  },
];

// Incluído em todos os planos.
export const included = [
  'Coleta UniFi em leitura',
  'Inventário por fazenda',
  'Importação de planilha com prévia',
  'Ocorrências e alerta crítico por e-mail',
  'Login com Microsoft Entra ID e MFA',
  'Papéis de administração, TI e diretoria',
];

export const onboarding = [
  { title: 'Cadastro', text: 'Conte quantas fazendas e qual plano interessa. Leva um minuto.' },
  { title: 'Conversa técnica', text: 'Revisamos a console UniFi de cada unidade e enviamos a proposta.' },
  { title: 'Configuração', text: 'Conectamos o diretório do grupo e geramos um código de ativação de uso único para cada coletor.' },
  { title: 'Acesso ao painel', text: 'Sua equipe entra pelo portal com a conta corporativa e acompanha as fazendas.' },
];
