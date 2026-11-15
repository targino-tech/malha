# Governança

## Papéis na comunidade

| Papel | Quem é | O que pode fazer |
| --- | --- | --- |
| **Usuário** | Quem roda o Malha ou o demo | Perguntar, sugerir e relatar erros nas discussões e issues |
| **Contribuidor** | Quem já teve um pull request aceito | Tudo acima; aparece na lista de contribuidores do GitHub |
| **Triagem** | Contribuidor convidado pela manutenção | Rotular, fechar duplicadas e organizar issues e o quadro do projeto |
| **Mantenedor** | Responsável técnico pelo projeto | Revisar e aceitar pull requests, publicar releases, tratar relatos de segurança |

Mantenedor atual: [@targino-tech](https://github.com/targino-tech). Os responsáveis por cada área ficam em [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Como alguém vira triagem ou mantenedor

Contribuições constantes e revisões cuidadosas ao longo de alguns meses. A manutenção faz o convite em privado; quem aceita passa a constar neste arquivo e no CODEOWNERS. A conta precisa usar autenticação em dois fatores.

## Como as decisões são tomadas

- Mudanças pequenas: decididas no próprio pull request, por quem revisa.
- Mudanças grandes (novo componente, mudança no modelo de dados, nova integração, quebra de compatibilidade): começam por uma [discussão de ideia](https://github.com/targino-tech/malha/discussions/categories/ideas) ou issue, com proposta e alternativas, antes do código.
- Buscamos consenso. Quando não há, a manutenção decide e registra o motivo na discussão.

## Princípios que não mudam sem discussão pública

1. Escopo de grupo e fazenda preservado em rotas, consultas, exportações e agregados.
2. O coletor é somente leitura e toda ingestão é assinada e idempotente.
3. Uma ligação porta a porta só aparece quando a evidência identifica as duas pontas.
4. O site descreve apenas o que já existe.
5. O projeto continua livre sob a AGPL-3.0-or-later, sem recurso bloqueado.

## Releases

A `main` é sempre implantável. O coletor sai por tags `collector-v*` assinadas pelo workflow de release; o site é publicado no GitHub Pages a cada mudança. As notas de release são geradas a partir dos rótulos dos pull requests.
