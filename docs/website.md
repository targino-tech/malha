# Site público e jornada do cliente

O site, o portal e o painel rodam no mesmo app Next.js (`apps/web`). Assim compartilham sessão, banco e deploy, e o cliente passa do site ao painel sem trocar de domínio.

```text
Visitante ──► /site ──► /site/planos ──► /site/cadastro ──► POST /api/site/requests ──► site_requests
                                                                                          │
                                         equipe Malha: pnpm db requests ◄─────────────────┘
                                                       pnpm db configure / farm / enroll
                                                                                          │
Cliente ───► /entrar (portal) ──► Microsoft Entra ID ──► / (painel do grupo) ◄────────────┘
```

| Rota | Papel |
| --- | --- |
| `/site` | Apresentação: globo ASCII, história do campo guiada pelo scroll, prévia do painel, segurança, planos e dúvidas |
| `/site/planos` | Planos, recursos incluídos e etapas de contratação |
| `/site/cadastro` | Formulário de solicitação. O plano chega pré-selecionado por `?plano=` |
| `/site/privacidade` | O que o formulário coleta e como os dados são usados (LGPD). Revise com o jurídico antes de divulgar |
| `/entrar` | Portal do cliente. Inicia o login Entra ID (no demo, abre o painel direto) |
| `/` | Painel web do grupo autenticado |

## Cadastro

`POST /api/site/requests` aceita JSON de até 8 KiB e grava em `site_requests` (migração `004`).

- **Origem.** No piloto, exige `Origin` igual a `MALHA_PUBLIC_ORIGIN`, como as demais rotas com escrita.
- **Idempotência.** O navegador gera o `id` uma vez por formulário. Reenvios com o mesmo `id` não criam outra linha.
- **Limite.** 5 envios por cliente e 300 no total por hora, contados sob lock transacional. O cliente é identificado pelo HMAC do último endereço de `X-Forwarded-For` (o que o proxy acrescenta), sem guardar o IP.
- **Robôs.** O campo oculto `website` precisa chegar vazio.
- **Escopo.** A solicitação não pertence a nenhum grupo. O runtime só pode `SELECT` e `INSERT` nessa tabela, e nenhuma rota pública lê os registros. A equipe consulta com `pnpm db requests`.

## Ainda não implementado

- **Cobrança e assinatura recorrente.** Os planos aparecem como "sob consulta" e a contratação é por proposta. Para cobrança online, o próximo passo é um provedor (Stripe, Pagar.me ou Asaas) com checkout hospedado e webhook assinado que mude o status da solicitação para `provisioned` e dispare o provisionamento do grupo.
- **Provisionamento automático.** Hoje o grupo, as fazendas e os códigos de ativação são criados pela CLI. Um painel administrativo interno pode transformar uma solicitação aprovada em grupo.
- **Aviso à equipe.** O worker pode enviar um e-mail a cada solicitação nova, reaproveitando o SMTP dos alertas.

## Animações e acessibilidade

O globo e o campo são desenhados com caracteres em `<canvas>` e ficam ocultos para leitores de tela. As rotas do globo são ilustrativas e a página indica isso. Com movimento reduzido, os dois quadros ficam estáticos, a história do campo vira uma lista e o letreiro para. As animações pausam fora da tela. A máscara de continentes vem do Natural Earth 1:50m (domínio público), embutida em `apps/web/src/app/site/_components/land-mask.ts`.
