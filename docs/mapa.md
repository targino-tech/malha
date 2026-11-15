# Mapa das fazendas

A aba **Mapa** do painel mostra as fazendas do escopo do usuário num mapa real (MapLibre GL JS 6.16.0, BSD-3-Clause),
com mapa de calor, agrupamento, agregação por estado e região e uma tabela com as mesmas métricas. Ela complementa o
mapa ASCII do parque na Visão geral, que continua igual.

## Dados

A tela consome só `GET /api/network/geo?period=24h|7d|30d` (contrato em [rede.md](rede.md)) e os dados de
`/api/dashboard`, que já vêm filtrados por grupo e fazenda. Nenhuma rota nova foi criada. O geoprocessamento roda no
navegador, em [`components/dashboard/geo/analysis.ts`](../apps/web/src/components/dashboard/geo/analysis.ts):

| Item | Regra |
| --- | --- |
| Saúde | **Crítico**: coletor sem contato ou ativo crítico offline. **Atenção**: ativo offline ou ocorrência aberta. **Sem coletor**: nenhum coletor ativo. Senão, **Saudável**. Agrupamentos, estados e regiões mostram a pior. |
| Métricas do calor | Volume de tráfego (rx + tx estimados), ativos offline, ocorrências abertas e dados enviados pelo coletor (`payloadBytes`). O peso é a raiz do valor dividido pelo maior valor visível, para uma fazenda grande não apagar as outras. Zero não aparece no calor. |
| Período | Controle deslizante com as três janelas da API: 24 h, 7 dias e 30 dias. |
| UF e região | UF lida do fim do campo `location` (`Rio Verde · GO`, `Cascavel/PR`). Região pela divisão do IBGE. Sem UF reconhecida, a fazenda entra em "Sem UF". |
| Fazenda mais próxima | Distância de grande círculo (haversine) até a fazenda posicionada mais próxima **dentro do escopo do usuário**. Uma fazenda que ele não vê nunca aparece como vizinha. |

Fazendas sem coordenadas, ou com coordenadas fora da faixa válida, ficam fora do mapa e aparecem na tabela como
"Sem coordenadas". Dados com `synthetic: true` são rotulados como fictícios.

## Interação e acessibilidade

- Marcadores coloridos por saúde e, como segunda codificação, um anel nas fazendas em atenção (fino) e críticas
  (grosso). A legenda e a tabela trazem o rótulo escrito.
- Clique num agrupamento aproxima; clique numa fazenda abre os detalhes. O popup é montado com `textContent`: nenhum
  texto da API vira HTML.
- A tabela de fazendas é ordenável por qualquer coluna (botões no cabeçalho com `aria-sort`). "Ver no mapa" centraliza a
  fazenda e abre os detalhes; a tabela por estado/região troca o agrupamento com botões de alternância.
- Teclado: com o foco no mapa, setas movem e `+`/`-` aproximam. Gestos cooperativos: na página, a rolagem só aproxima
  com Ctrl (ou ⌘) e, no toque, o mapa move com dois dedos, para não prender a rolagem no celular.
- Com movimento reduzido, nenhuma animação de câmera (transições com duração zero) e sem esmaecimento de rótulos. Não há
  voo (`flyTo`) em nenhum caso. Rotação e inclinação estão desligadas.
- Sem WebGL 2, a tela explica que o mapa interativo não está disponível e mantém as duas tabelas.
- Se o estilo do mapa base não carrega (rede, servidor fora, bloqueio), o mapa troca para um fundo local com o contorno
  de MT e dos vizinhos, sem nenhuma requisição externa, e avisa.

## Configuração

| Variável | Padrão | Uso |
| --- | --- | --- |
| `NEXT_PUBLIC_MAP_STYLE_URL` | `https://tiles.openfreemap.org/styles/dark` | Estilo MapLibre do mapa base. OpenFreeMap: dados do OpenStreetMap, sem chave nem cadastro. Aceita só `https`, um caminho do próprio Malha (`/mapa/estilo.json`) ou `none` para desligar o mapa base. É fixada no **build**. |
| `MALHA_MAP_EXTRA_ORIGINS` | vazio | Origens extras (separadas por vírgula, só `https://host[:porta]`, sem curinga nem caminho) que o estilo usa em outro host, como tiles ou glifos de um CDN. Valores inválidos são ignorados. Defina no build e na execução. |

A atribuição "© colaboradores do OpenStreetMap" aparece sempre que há mapa base, junto com a do próprio estilo. Ao
trocar de provedor, confira a licença dos tiles e a política de uso, e mantenha a atribuição exigida.

## CSP

A política com nonce de `/` (em `src/proxy.ts`) ganha só o necessário, e só na página do painel:

- `connect-src` e `img-src`: `'self'` mais a origem do estilo configurado e as origens extras. Nada de curinga.
- `worker-src 'self'`: o worker do MapLibre é servido pelo próprio Malha (`/_next/static/media/maplibre-gl-worker.<hash>.mjs`),
  sem `blob:`. Sem isso, `'strict-dynamic'` bloquearia o worker.
- O arquivo do worker recebe uma política própria em `next.config.ts` (`default-src 'none'`, `connect-src` com as mesmas
  origens, `img-src 'self' data: blob:`), porque o worker segue a CSP da própria resposta.

O portal `/entrar` e as páginas estáticas não recebem as origens do mapa. Nenhuma regra usa `'unsafe-eval'`.

## Carregamento

O MapLibre (JS, CSS e worker) só é baixado quando a aba Mapa é aberta: o componente do mapa entra por `next/dynamic`
com `ssr: false` e o pacote é importado dentro do efeito.

## Testes

- `tests/mapa-geo.test.ts`: UF e região, saúde, haversine e vizinha mais próxima, coordenadas inválidas, pesos do calor,
  agregação, ordenação, configuração do estilo, origens da CSP (incluindo a do worker) e escopo: técnico de uma fazenda
  e outro grupo não recebem nomes, distâncias nem somas de fazendas fora do escopo.
- `tests/e2e/mapa-geo.spec.ts`: aba Mapa no demo com o mapa base bloqueado (fundo local), CSP estreita, ordenação por
  teclado, troca UF/região, métrica e período, popup a partir da tabela, nenhuma violação de CSP e 360 px sem rolagem
  horizontal.
