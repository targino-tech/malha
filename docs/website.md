# Site público e jornada do cliente

O site, o portal e o painel rodam no mesmo app Next.js (`apps/web`). Assim compartilham sessão, banco e deploy, e o cliente passa do site ao painel sem trocar de domínio.

```text
Visitante ──► /site ──► /site/open-source ──► /site/cadastro ──► POST /api/site/requests ──► site_requests
                                                                                          │
                                         equipe Malha: pnpm db requests ◄─────────────────┘
                                                       pnpm db configure / farm / enroll
                                                                                          │
Cliente ───► /entrar (portal) ──► Entra ID, AD/LDAP ou OIDC ──► / (painel do grupo) ◄────────────┘
```

| Rota | Papel |
| --- | --- |
| `/site` | Apresentação: globo ASCII, história do campo guiada pelo scroll, prévia do painel, segurança, open source e dúvidas |
| `/site/open-source` | Licença, como usar, como contribuir e etapas de implantação (`/site/planos` redireciona para cá) |
| `/site/cadastro` | Pedido de apoio na implantação |
| `/site/privacidade` | O que o formulário coleta e como os dados são usados (LGPD). Revise com o jurídico antes de divulgar |
| `/entrar` | Portal do cliente: Entra ID, AD/LDAP ou o provedor OIDC configurado (no demo, abre o painel direto) |
| `/` | Painel web do grupo autenticado |

## Cadastro

`POST /api/site/requests` aceita JSON de até 8 KiB e grava em `site_requests` (migração `007`).

- **Origem.** No piloto, exige `Origin` igual a `MALHA_PUBLIC_ORIGIN`, como as demais rotas com escrita.
- **Idempotência.** O navegador gera o `id` uma vez por formulário. Reenvios com o mesmo `id` não criam outra linha.
- **Limite.** 5 envios por cliente e 300 no total por hora, contados sob lock transacional. O cliente é identificado pelo HMAC do último endereço de `X-Forwarded-For` (o que o proxy acrescenta), sem guardar o IP.
- **Robôs.** O campo oculto `website` precisa chegar vazio.
- **Escopo.** A solicitação não pertence a nenhum grupo. O runtime só pode `SELECT` e `INSERT` nessa tabela, e nenhuma rota pública lê os registros. A equipe consulta com `pnpm db requests`.

## Ainda não implementado

- **Provisionamento automático.** Hoje o grupo, as fazendas e os códigos de ativação são criados pela CLI. Um painel administrativo interno pode transformar uma solicitação aprovada em grupo.
- **Aviso à equipe.** O worker pode enviar um e-mail a cada solicitação nova, reaproveitando o SMTP dos alertas.

## GitHub Pages

A versão estática (`node scripts/build-static-site.mjs`) publica só as páginas de `/site` em `https://targino-tech.github.io/malha/`. Sem servidor, o portal vira "Rodar o demo" e o cadastro aponta para uma issue de implantação no GitHub.

## Animações e acessibilidade

O globo e o campo são desenhados com caracteres em `<canvas>` e ficam ocultos para leitores de tela. O globo alterna, em ciclos de 27 s, entre a visão do planeta com rotas entre países e uma aproximação de Mato Grosso com as fazendas do demo ligadas à matriz em Cuiabá. Rotas e fazendas são ilustrativas e a página indica isso. Os contornos de Mato Grosso e dos estados vizinhos vêm do Natural Earth 1:50m (domínio público), em `_components/mt-outline.ts`. Com movimento reduzido, os dois quadros ficam estáticos, a história do campo vira uma lista e o letreiro para. As animações pausam fora da tela. A máscara de continentes vem do Natural Earth 1:50m (domínio público), embutida em `apps/web/src/app/site/_components/land-mask.ts`.
