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

Sem trilha nem locução: adicione a sua no editor de preferência (com licença de uso para a música).

## Gerar

Requer Node.js 24, as dependências do projeto (`pnpm install`) e `ffmpeg` no PATH.

```sh
pnpm video                                  # video/out/malha-45s.mp4, 60 fps (~20 min)
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
