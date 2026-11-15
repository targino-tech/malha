# Como contribuir com o Malha

O Malha é open source sob a [AGPL-3.0-or-later](LICENSE). Ao enviar uma contribuição, você concorda em licenciá-la nos mesmos termos.

## Antes de começar

- Abra uma issue descrevendo o problema ou a proposta antes de mudanças grandes.
- Vulnerabilidades não vão em issue pública: siga a [política de segurança](SECURITY.md).
- Leia o [AGENTS.md](AGENTS.md). As mesmas regras valem para pessoas: preservar o escopo de grupo e fazenda em rotas, consultas, exportações e agregados; manter o coletor somente leitura; e descrever no site apenas o que já existe.

## Ambiente

Siga a seção **Rode o demo** do [README](README.md). O modo demo usa PGlite com dados fictícios e não precisa de banco externo.

## Antes de abrir o pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
cd collector && go test ./...
```

- Escreva mensagens de commit no imperativo e em português, como no histórico.
- Inclua testes para regras de negócio e para qualquer caminho que leia ou altere dados de outro grupo.
- Mudanças visuais no site precisam funcionar com teclado, em telas estreitas e com movimento reduzido.
