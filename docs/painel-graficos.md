# Painel macro de rede

Aba **Painéis → Rede** do painel. Reúne num só quadro os indicadores dos ativos de rede, o tráfego somado e por
fazenda, os maiores consumidores, a distribuição de VLANs e a utilização das portas de cada switch. Consome a base
descrita em [rede.md](rede.md); os gráficos são SVG e CSS feitos à mão, sem biblioteca de gráficos (nenhuma
dependência nova).

## Filtros e escopo

- **Fazenda**: o seletor do topo do painel. "Todas as fazendas" = todas as fazendas do escopo do usuário.
- **Período**: 24 horas (intervalos de 5 min), 7 dias (1 h) ou 30 dias (6 h). Os intervalos seguem uma origem fixa,
  então não mudam entre uma atualização e outra.
- Tudo roda com o grupo fixado (RLS `org_scope`) e filtrado pelas fazendas do usuário. Fazenda fora do escopo, de
  outro grupo ou com id inválido responde **404**, igual a uma inexistente. Período inválido responde 400.

## API `GET /api/network/panel?period=24h|7d|30d[&farmId=<uuid>]`

Tipos em [`apps/web/src/server/network/panel.ts`](../apps/web/src/server/network/panel.ts). `Cache-Control: no-store`.

| Campo | Conteúdo |
| --- | --- |
| `kpis.ports` | Portas com enlace (`up`), sem enlace (`down`), sem estado (`other`), total e dispositivos com portas lidas. |
| `kpis.utilization` | Média e pico (0–1) da série por porta no período, sobre a velocidade atual da porta, com a porta e o instante do pico. **Nulo** quando a fonte não expõe contadores por porta (caso do UniFi atual). |
| `kpis.errors` | Soma dos contadores acumulados de erros e descartes. Nulo sem contadores. |
| `kpis.poe` | Portas PoE ativas e potência somada; `powerMw` nulo quando nenhuma porta informa potência. |
| `kpis.vlans` | VLANs ativas (não desativadas) e total do catálogo. |
| `kpis.devices` | Dispositivos de rede offline e total (mesmo critério dos nós da topologia). |
| `traffic` | Série somada das fazendas: uplinks dos dispositivos raiz, mesma regra de `/api/network/traffic`. |
| `farms` | Cada fazenda do escopo, com volume, pico e uma série curta para a sparkline (fazendas sem tráfego também aparecem). |
| `topDevices` | Até 8 dispositivos com mais volume de uplink no período. |
| `topPorts` | Até 8 portas com maior taxa atual derivada de contadores. |
| `vlans` | Catálogo agrupado pelo número da VLAN entre as fazendas, com portas nativas e marcadas. |
| `switches` | Até 40 switches com até 128 portas cada, na ordem física, e a utilização atual de cada porta. A consulta lê no máximo 2.000 ativos com portas para achar os switches e só então carrega as portas dos 40 exibidos. `switchesTruncated` indica corte (mais de 40 switches ou o teto de 2.000 ativos atingido). Os indicadores continuam contando todas as portas. |
| `synthetic` | Verdadeiro quando algum dado é fictício (demo); a tela mostra "Dados de rede fictícios". |

Utilização de porta = maior sentido (RX ou TX) ÷ velocidade negociada, limitada a 100% (porta full duplex). Sem
taxa ou sem velocidade, a utilização é "não medida", nunca zero.

## Tela

- **Indicadores**: portas ativas e inativas, utilização média e pico, erros, PoE consumido, VLANs ativas e
  dispositivos offline. Valor ausente aparece como "—" com o motivo (por exemplo, "A fonte não expõe contadores por porta").
- **Tráfego recebido e enviado**: áreas com degradê (`linearGradient` com os tokens `--net-rx` verde e `--net-tx`
  trigo). Intervalos sem amostra ficam em branco: a linha quebra quando a distância passa de 2,5× o espaçamento típico.
- **Tráfego por fazenda**: sparkline por fazenda, na mesma escala para comparar, com volume e pico.
- **Dispositivos e portas com mais tráfego**: barras horizontais.
- **Distribuição de VLANs**: barras empilhadas nativa × marcada.
- **Utilização das portas por switch**: tira de calor com uma célula por porta; cinco faixas de utilização, cinza para
  "com enlace, sem medição", contorno vazio para "sem enlace" e um traço inferior para PoE ativo (forma, não só cor).

Acessibilidade e responsividade:

- Todo gráfico tem o botão **Ver tabela** com os mesmos números.
- Dicas acessíveis pelo teclado: o gráfico de tráfego e cada tira de switch recebem foco; setas, Home/End (e Page
  Up/Down no tráfego) percorrem os pontos, com leitura em `aria-live`.
- Números em pt-BR com múltiplos decimais: `1,2 Mbit/s`, `1,5 GB`, `37,5%`, `12,4 W`
  ([`network-format.ts`](../apps/web/src/components/dashboard/network-format.ts)).
- Sem animação além da opacidade do recarregamento, desligada com `prefers-reduced-motion`. Em telas estreitas os
  indicadores ficam em duas colunas e as tiras de calor quebram linha.
- O painel tem só tema escuro hoje; os degradês e a escala de calor leem tokens CSS (`--net-rx`, `--net-tx`,
  `--heat-*` em `.net-panel`), então um tema claro só precisa redefini-los.

## Testes

- `tests/painel-graficos.test.ts`: formatação, geometria (trechos com lacuna, caminhos SVG), agregações (soma das
  séries, agrupamento de VLANs, utilização) e a API no demo, incluindo outro grupo e fazenda fora do escopo (404),
  técnico restrito à própria fazenda e fazenda sem dados de rede (vazio, não erro).
- `tests/e2e/painel-graficos.spec.ts`: a aba Rede com teclado, tabela alternativa, período e filtro por fazenda.

Sem migração nova: o painel só lê as tabelas da migração `012_dados_rede.sql`.
