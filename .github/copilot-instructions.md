# Instruções para agentes de código

Leia e siga o [AGENTS.md](../AGENTS.md) da raiz. Resumo das regras e do jeito de trabalhar neste repositório:

## Regras que não se negociam

- Preserve o escopo de grupo (`org_id`) e de fazenda em rotas, consultas, exportações e agregados. Toda consulta em tabela com RLS roda dentro de uma transação com `setOrg(tx, orgId)`. Fazenda fora do escopo responde 404, não 403.
- O coletor (`collector/`) é somente leitura na controladora UniFi. A ingestão em `/v1/collectors` verifica a assinatura Ed25519, o nonce e o hash do corpo; capturas repetidas devolvem o recibo original e conteúdo divergente recebe 409.
- Uma ligação porta a porta só aparece quando a evidência identifica as duas pontas.
- O site (`apps/web/src/app/site`) descreve só o que já existe, marca dados fictícios e funciona com teclado, tela estreita e movimento reduzido.
- Nunca use dados reais de clientes, IPs ou segredos em código, testes ou fixtures.

## Stack e comandos

- Next.js 16 (App Router), React 19, TypeScript, Motion, zod; PostgreSQL 17 com RLS (PGlite no demo); coletor em Go 1.27.
- `pnpm install --frozen-lockfile`, `MALHA_MODE=demo pnpm dev`.
- Antes de concluir: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; para o coletor, `cd collector && go test ./...`.
- Testes Node em `tests/*.test.ts` (PGlite em memória); e2e com Playwright em `tests/e2e`.
- Migrações novas: arquivo numerado em `packages/db/`, adicionado à lista em `apps/web/src/server/db.ts`, com grants em `packages/db/runtime-grants.sql`.

## Estilo

- Textos de interface, mensagens de erro e commits em português do Brasil; commits no imperativo.
- Erros de API com `HttpError(status, mensagem)`; validação de entrada com zod.
- Mantenha as Actions fixadas por SHA com o comentário da versão.
