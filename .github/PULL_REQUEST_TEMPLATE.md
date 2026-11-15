<!-- Obrigado pela contribuição! Vulnerabilidades: use o relato privado em Security, não um PR público. -->

## O que muda

<!-- Uma ou duas frases sobre o problema e a solução. -->

Fecha #

## Como testar

<!-- Passos para quem revisa conferir no demo (MALHA_MODE=demo pnpm dev). -->

1.

## Capturas de tela

<!-- Para mudanças visuais: antes e depois, em tela larga e estreita. Sem dados reais. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm build` passam (e `go test ./...` se mexi no coletor).
- [ ] Incluí ou atualizei testes para o comportamento novo.
- [ ] Toda consulta, rota, exportação ou agregado novo respeita o escopo de grupo e de fazenda.
- [ ] O coletor continua somente leitura; a ingestão continua assinada e idempotente.
- [ ] Não há segredos, IPs, nomes de fazendas ou dados de clientes reais no código, nos testes ou nas capturas.
- [ ] Documentação e `.env.example` atualizados se mudei configuração ou comportamento.
- [ ] Mudança visual funciona com teclado, em tela estreita e com movimento reduzido.
- [ ] Dependência nova tem licença compatível com a AGPL-3.0 e foi justificada acima.
