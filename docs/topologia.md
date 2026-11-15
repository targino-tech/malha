# Topologia de rede

A aba **Topologia** do painel mostra, por fazenda, como gateway, switches e pontos de acesso se ligam. A tela só
consome a API de [dados de rede](rede.md) (`/api/network/topology`, `/devices/<id>/ports`, `/vlans` e `/traffic`).
Ela não cria rota, tabela nem migração. Por isso escopo de grupo e fazenda, RLS e a resposta 404 para fazenda ou ativo
fora do escopo vêm das próprias rotas de rede.

Código:

- [`components/dashboard/topology-graph.ts`](../apps/web/src/components/dashboard/topology-graph.ts): regras do grafo,
  sem React (evidência, hierarquia, desenho, teclado, filtro de VLAN e frescor).
- [`components/dashboard/topology.tsx`](../apps/web/src/components/dashboard/topology.tsx) e `topology.module.css`:
  a tela.
- Testes: [`tests/topologia-rede.test.ts`](../tests/topologia-rede.test.ts) e
  [`tests/e2e/topologia-rede.spec.ts`](../tests/e2e/topologia-rede.spec.ts).

## Regras de evidência

- **Nenhuma ligação é inventada.** Toda aresta desenhada vem de `edges` da API. As ligações sem nó nas duas pontas e
  os laços são descartados. Quando o mesmo par aparece mais de uma vez, mesmo em sentido invertido, fica só a ligação
  de evidência mais forte.
- **Porta a porta** (linha contínua, com os rótulos `P<n>` nas duas pontas) só aparece quando `level = 'port'` e as
  duas portas estão preenchidas. Qualquer outra combinação vira **ligação entre dispositivos** (linha tracejada) e
  as portas não são mostradas.
- O equipamento sem nenhuma ligação vai para o grupo **"Sem ligação conhecida"**. Ele não é pendurado no gateway.
- O equipamento com mais de um uplink usa o mais forte para a hierarquia (porta a porta, depois LLDP, depois o uplink
  UniFi, depois o mais recente). Os outros uplinks continuam desenhados, com traço mais fino, e aparecem como
  "Ligação adicional" na tabela.
- Ciclo: a ligação que fecharia o ciclo não posiciona o nó, mas continua desenhada.
- A evidência aparece no detalhe e na tabela: uplink informado pelo UniFi, vizinhança LLDP ou dado fictício do demo.

Com o coletor UniFi atual, toda ligação real é **entre dispositivos**, porque a API de Integrações não informa a porta
do uplink. O porta a porta aparece no demo, com dados fictícios, e com fontes LLDP no futuro.

## Tela

- **Grafo** em SVG, de cima para baixo: raízes (gateway), switches e APs. O pai fica centralizado sobre os filhos.
  Cada estado tem uma cor (online, offline e indeterminado), sempre acompanhada de um ícone. O offline também leva
  hachura e contorno tracejado. Os ícones de papel são do lucide (gateway, switch, AP, rádio e outro), e o equipamento
  crítico leva uma estrela.
- **Pan e zoom**: arraste para mover, Ctrl + rolagem ou pinça para aproximar, e os botões Aproximar, Afastar e
  Ajustar à tela. A rolagem simples continua rolando a página.
- **Teclado**: Tab entra no grafo (um nó por vez, com tabindex móvel). ↑ vai ao equipamento a montante, ↓ ao primeiro
  a jusante, ←/→ aos irmãos e Home/End aos extremos. Enter ou Espaço abre o detalhe, `+`, `-` e `0` controlam o zoom
  e Esc fecha o detalhe. O nó focado é trazido para a área visível.
- **Detalhe do equipamento**: estado, IP, MAC, uplink com nível e evidência, equipamentos a jusante e a taxa de uplink
  com a tendência de 24 h. A tabela de portas mostra estado, conector, velocidade, PoE (estado, padrão e potência
  quando houver), VLAN nativa, VLANs marcadas, RX/TX e a tendência de 24 h da porta. A tendência só aparece quando a
  fonte tem série por porta.
- **Filtro de VLAN** ("Destacar VLAN"): carrega as portas dos equipamentos da fazenda (até 150, com 4 requisições em
  paralelo). O contorno em trigo marca os equipamentos que levam a VLAN, como nativa ou marcada, e as portas que a
  levam ficam destacadas na tabela. Os demais equipamentos ficam esmaecidos. Equipamento cuja fonte não informa VLAN
  por porta conta como "sem VLAN por porta informada", nunca como "não leva".
- **Tabela alternativa** ("Ver tabela"): uma tabela de equipamentos, na ordem da hierarquia, e outra de ligações, com
  nível, evidência e portas. O nome do equipamento abre o detalhe.
- **Estados**:
  - carregando;
  - erro, com "Tentar de novo" e a última consulta mantida;
  - sem conexão;
  - fazenda sem equipamentos de rede;
  - portas não lidas (`null`) ou equipamento sem portas (`[]`);
  - desenho truncado (`truncated`);
  - desatualizado, quando a observação mais recente tem mais de 15 minutos;
  - **Dados fictícios**, quando as ligações são sintéticas ou o painel está no demo.
- **Tela estreita**: o detalhe vai para baixo do grafo e as tabelas rolam na horizontal.
- **Movimento reduzido**: o ajuste e a centralização acontecem sem animação.
- **Alto contraste** (`forced-colors`): cores do sistema.

## Lacunas do contrato

- **Clientes por AP**: a API de dados de rede não expõe quantos clientes estão ligados a cada AP. O detalhe mostra
  "Não informado pela fonte de dados" em vez de um número inventado. Quando o contrato ganhar esse campo, ele entra
  no rótulo do nó.
- **TX/RX por porta**: só existe quando a fonte manda contadores. O UniFi atual não manda, e a tela avisa que o
  tráfego vem do uplink do equipamento.
- **VLAN por porta**: o UniFi atual não informa. O filtro funciona com os dados do demo e com fontes que a tenham.

## Como testar

```sh
node_modules/.bin/tsx --test tests/topologia-rede.test.ts
node_modules/.bin/next build apps/web --webpack
node_modules/.bin/playwright test tests/e2e/topologia-rede.spec.ts
```

No demo, a Fazenda Cerrado Alto e a Fazenda Três Pinheiros exercitam os dois níveis de ligação, o switch offline e o
filtro de VLAN. A Fazenda Santa Luzia fica sem portas nem VLANs.
