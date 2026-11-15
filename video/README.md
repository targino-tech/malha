# Vídeo do Malha (45 s, 1920 × 1080)

Vídeo de apresentação feito com o mesmo visual do site: globo ASCII, contorno de Mato Grosso, logo da folha e telas reais do painel em modo demo. Não há programa de edição: cada cena é uma página web animada em função do tempo, gravada quadro a quadro.

| Tempo | Cena |
| --- | --- |
| 0 – 4 s | A folha da logo se forma e o nome aparece |
| 4 – 12 s | Globo com rotas, aproximação até Mato Grosso e as fazendas de exemplo ligadas à matriz |
| 12 – 20 s | A fazenda perde a internet: o coletor guarda a fila, a matriz abre a ocorrência em 3 min e tudo chega quando a conexão volta |
| 20 – 28 s | Visão geral do parque tecnológico e painéis da operação (dados de demonstração) |
| 28 – 36 s | Famílias do inventário viram hosts no Zabbix e painéis no Grafana |
| 36 – 41 s | Login com Entra ID, AD/LDAP ou OpenID Connect e as garantias de isolamento |
| 41 – 45 s | Grátis e open source, com os endereços do site e do repositório |

## Som

A trilha e os efeitos são sintetizados por código em [`sound.mjs`](sound.mjs), sem amostras de terceiros: música eletrônica a 120 BPM em lá menor (Lá m – Fá – Dó – Sol), com batida, baixo, acordes e arpejo, e efeitos presos à linha do tempo da imagem:

- impacto e "plins" quando a folha e os nós da logo aparecem, e o drop da batida aos 4 s;
- pings de dados nas rotas do globo, mergulho até Mato Grosso e "lock-on" nas fazendas;
- bipes dos pacotes, glitch e queda de energia quando a internet cai (a música fica abafada), cliques da fila, alarme da ocorrência, religamento e rajada de bipes no reenvio;
- cliques, pops e sinos nos destaques do painel, nas famílias do monitoramento, nos provedores de login e nas garantias;
- riser e grande impacto no final.

A mixagem sai normalizada a -14 LUFS com pico abaixo de -1 dBFS, o padrão de YouTube e redes sociais. O `.wav` separado fica em `video/out/malha-45s.wav` para quem quiser editar.

## Gerar

Requer Node.js 24, as dependências do projeto (`pnpm install`) e `ffmpeg` no PATH.

```sh
pnpm video                                  # video/out/malha-45s.mp4 com som, 60 fps (~20 min)
pnpm video:som                              # só refaz a trilha e junta com a imagem já gerada (segundos)
node video/render.mjs --fps 30              # mais rápido, para revisar
node video/render.mjs --from 12 --to 20     # só um trecho
node video/render.mjs --still 16.8          # um quadro em PNG
```

Se o Chromium do Playwright não estiver instalado, rode `pnpm exec playwright install chromium` ou aponte um já existente com `MALHA_CHROMIUM=/caminho/do/chromium`.

Para pré-visualizar no navegador, gere o bundle uma vez com o comando acima, sirva a raiz do repositório (por exemplo, `python3 -m http.server 8080`) e abra `http://localhost:8080/video/index.html`: o vídeo toca em loop.

## Editar

- Textos e layout: [`index.html`](index.html).
- Linha do tempo e animações: [`src/main.ts`](src/main.ts). Cada cena tem um intervalo em segundos e tudo é calculado a partir de `t`, então dois renders saem idênticos.
- Globo: [`src/globe.ts`](src/globe.ts), com a mesma projeção e as mesmas fazendas fictícias do globo do site.
- Telas do painel: [`assets/`](assets), capturadas do modo demo (`MALHA_MODE=demo`). Ao mudar o painel, capture de novo em 1600 × 1000 com escala 2.

Tudo o que o vídeo mostra já existe no Malha; telas e fazendas são de demonstração e estão marcadas assim.
