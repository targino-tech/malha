# Instalação e operação

Guia completo para rodar o Malha, do demo ao ambiente de produção. O resumo está no [README](../README.md).

## Demo local

Requisitos: Node.js **24.22.3** e pnpm **12.18.0**. O demo usa PGlite com dados fictícios e persiste em `.malha/demo` (use `MALHA_DEMO_DB=memory://` para uma sessão descartável).

```sh
npm install --global pnpm@12.18.0
pnpm install --frozen-lockfile
MALHA_MODE=demo pnpm dev
```

No PowerShell, use `$env:MALHA_MODE = 'demo'` antes de `pnpm dev`. Abra [http://127.0.0.1:3000](http://127.0.0.1:3000) para o painel e [/site](http://127.0.0.1:3000/site) para o site. Com Docker:

```sh
docker build --target web -t malha-web .
docker run --rm -p 3000:3000 -e MALHA_MODE=demo -e MALHA_DEMO_DB=memory:// malha-web
```

### Roteiro do demo em 9 passos

1. Em **Importações**, selecione uma fazenda e envie o [CSV de exemplo](../examples/inventario.csv). Valide, confira a prévia e confirme.
2. Em **Inventário**, filtre a fazenda, encontre `CAMPO-002` e abra os detalhes.
3. Em **Ocorrências**, veja o coletor sem contato da Fazenda Santa Luzia e o switch offline da Fazenda Vale Verde e reconheça uma delas.
4. Em **Administração**, cadastre uma fazenda e um membro. Em **Integrações**, gere o código de ativação da nova fazenda.
5. Em **Inventário**, use **Novo ativo** com local técnico, responsável e janela de manutenção. Arquive e restaure pelo detalhe, que mostra o histórico.
6. Em **Conciliação**, confira um item do cadastro e confirme ou vincule uma descoberta UniFi.
7. Em **Indicadores**, defina a linha de base. Em **Ocorrências**, registre um atendimento e volte aos indicadores.
8. Em **Auditoria**, veja as ações registradas e exporte o CSV.
9. No site, abra **Open source** e envie o **cadastro** de apoio. Liste as solicitações com `pnpm db requests`.

O CSV aceita UTF-8, até 5 MiB e 10 mil linhas, com as colunas `etiqueta`, `nome` e `categoria` e, opcionalmente, `criticidade`, `mac` e `ip`.

## Coletor UniFi

Instale Go **1.27.4** e rode os comandos em `collector/`. Configure o prefixo local de Integrações documentado pela console, por exemplo `https://console.example/proxy/network/integration/v1`, uma chave da integração e a cadeia TLS confiável (`UNIFI_CA_FILE` para CA privada).

```sh
cd collector
go build -o malha-collector .
export UNIFI_BASE_URL='https://console.example/proxy/network/integration/v1'
export UNIFI_API_KEY_FILE='/caminho/protegido/unifi-api-key'
./malha-collector sites
export UNIFI_SITE_ID='<UUID do site selecionado>'
export MALHA_DATA_DIR='/caminho/gravavel/malha'
export MALHA_URL='https://malha.example'
export MALHA_ENROLL_CODE_FILE='/caminho/protegido/codigo-uso-unico'
./malha-collector enroll
unset MALHA_ENROLL_CODE_FILE
./malha-collector run
```

O código de ativação associa o coletor a uma única fazenda. Para testar com uma controladora de laboratório, inicie o demo com `MALHA_DEMO_DB=memory://`, use `MALHA_URL=http://127.0.0.1:3000` e `MALHA_ENROLL_CODE=malha-demo-entrada-000000000000000000000000` (fictício, vinculado à Fazenda Horizonte). Releases assinadas saem com a tag `collector-vX.Y.Z` e são instaladas com [`collector/deploy/update.sh`](../collector/deploy/update.sh), que verifica assinatura e checksum e volta à versão anterior se o serviço não subir. Veja [o guia do serviço Linux](../collector/README.md).

## Ambiente de piloto ou produção

Use PostgreSQL 17 com endpoint privado (o [`compose.yml`](../compose.yml) sobe um banco de laboratório). Configure `MALHA_MODE=pilot`, `DATABASE_URL` e as variáveis do [`.env.example`](../.env.example). Cadastre a aplicação como **Web** no Entra ID, permita só o diretório do cliente, registre `https://<host-do-app>/api/auth/callback`, restrinja a atribuição de usuários e aplique MFA.

Prepare o banco com um papel administrativo separado. Após migrar, aplique [`packages/db/runtime-grants.sql`](../packages/db/runtime-grants.sql) e conceda `malha_runtime` ao login do serviço, sem `SUPERUSER` nem `BYPASSRLS`.

```sh
pnpm db migrate
pnpm db configure <tenant-id> <oid-do-administrador> 'Grupo piloto'
pnpm db recipient <org-id> <email>
pnpm build
```

Depois do primeiro admin, fazendas, membros e coletores são cadastrados na interface. Rode `pnpm worker` junto com o serviço web e configure `MALHA_SMTP_URL` e `MALHA_ALERT_FROM` (o SMTP do Amazon SES serve). Na AWS, siga [`infra/README.md`](../infra/README.md).

### Login por Active Directory ou LDAP

Além do Microsoft Entra ID, o portal aceita a conta da rede. Configure o diretório do grupo pela CLI, com a senha da conta de serviço em arquivo protegido:

```sh
export MALHA_AUTH_SECRET='<a mesma do serviço web>'
export MALHA_LDAP_BIND_PASSWORD_FILE='/caminho/protegido/senha-servico'
pnpm db ldap <org-id> grupo.local ldaps://dc.grupo.local:636 'DC=grupo,DC=local' 'CN=svc-malha,OU=Servicos,DC=grupo,DC=local'
```

Só conexões cifradas são aceitas (`ldaps://`, ou `ldap://` com StartTLS automático). Para OpenLDAP, use `MALHA_LDAP_ID_ATTRIBUTE=entryUUID`; para uma CA própria, `MALHA_LDAP_CA_FILE`. Cada pessoa entra como membro em Administração pelo `objectGUID` (ou `entryUUID`). A senha da conta de serviço fica cifrada no banco, as tentativas são limitadas e o login vai para a auditoria.

### Login por Google Workspace, Okta, Keycloak ou outro OpenID Connect

Um provedor OIDC genérico pode atender um grupo, ao lado do Entra ID e do LDAP. No provedor, cadastre um aplicativo web com o redirecionamento `https://<seu-dominio>/api/auth/oidc/callback` e configure o serviço:

```sh
export MALHA_PUBLIC_ORIGIN='https://malha.grupo.com.br'
export MALHA_OIDC_ISSUER='https://accounts.google.com'   # ou https://<tenant>.okta.com, https://<keycloak>/realms/<realm>
export MALHA_OIDC_CLIENT_ID='...'
export MALHA_OIDC_CLIENT_SECRET='...'
export MALHA_OIDC_ORG_ID='<uuid do grupo>'
export MALHA_OIDC_NAME='Google'                           # rótulo do botão "Entrar com ..."
# export MALHA_OIDC_CLIENT_AUTH=post                      # só se o provedor exigir o segredo no corpo
```

O segredo do cliente vai por HTTP Basic (`client_secret_basic`, o padrão do OpenID Connect). Use `MALHA_OIDC_CLIENT_AUTH=post` se o aplicativo no provedor estiver configurado para `client_secret_post`.

| Provedor | Emissor (`MALHA_OIDC_ISSUER`) | No provedor |
| --- | --- | --- |
| Google Workspace | `https://accounts.google.com` | Google Cloud Console → APIs e serviços → Credenciais → ID do cliente OAuth do tipo **Aplicativo da Web**, com o URI de redirecionamento acima. A tela de consentimento pode ser **Interna** para aceitar só contas do domínio. O Google envia `email_verified`. |
| Okta | `https://<empresa>.okta.com/oauth2/default` (servidor de autorização padrão) ou `https://<empresa>.okta.com` | Applications → Create App Integration → **OIDC · Web Application**, grant **Authorization Code**, URI de redirecionamento acima e atribuição aos grupos que podem entrar. Client authentication **Client secret** (Basic). |
| Keycloak | `https://<host>/realms/<realm>` | Clients → Create client → **OpenID Connect**, **Client authentication: On**, **Standard flow**, Valid redirect URIs com o endereço acima. Marque **Email verified** nos usuários (ou use a verificação de e-mail do realm): sem isso o primeiro login é recusado. |
| Microsoft Entra ID | Use a integração própria (`ENTRA_*`), não o OIDC genérico. | |

Requisitos do provedor: descoberta em `/.well-known/openid-configuration`, fluxo de código com PKCE S256, ID token assinado e claims `sub`, `email` e `email_verified`. O fluxo inteiro (descoberta, PKCE, state, nonce, assinatura e convite) é testado contra um provedor local que segue a especificação, em [`tests/oidc-flow.test.ts`](../tests/oidc-flow.test.ts); a validação com cada provedor real segue aberta na comunidade.

O acesso continua por convite: em Administração, crie o membro com o **e-mail do convite** (o identificador no diretório pode ficar em branco). No primeiro login, o Malha só aceita a conta se o provedor confirmar o e-mail como verificado; a partir daí a conta fica ligada pelo identificador estável do provedor (`iss` + `sub`), mesmo que o e-mail mude depois. O convite só pode ser usado uma vez, a ligação vai para a auditoria e desativar o membro bloqueia o login.

## Estrutura do repositório e verificações

```text
apps/web/      Painel, API, ingestão, site e portal (Next.js)
apps/worker/   Outbox, regras de ocorrência, e-mail, retenção e métricas
packages/db/   Migrações SQL, grants do runtime e CLI de administração
collector/     Coletor Go, fila SQLite, serviço systemd e atualização assinada
infra/         Terraform da AWS em sa-east-1
tests/         Testes Node (PGlite) e Playwright
docs/          Instalação, arquitetura, integrações, site e mídia do README
video/         Vídeo de apresentação (cenas, trilha e render)
```

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm exec playwright install chromium && pnpm test:e2e
cd collector && go test ./...
```

O CI roda tudo isso com PostgreSQL 17 real, constrói e sobe a imagem Docker e valida o Terraform. O workflow de segurança roda Semgrep, auditoria de dependências, Gitleaks e ClamAV.

## Branches e entrega

| Branch | Papel | Como muda |
| --- | --- | --- |
| `main` | Código integrado e sempre verde; publica o site no GitHub Pages | PR com CI e revisão aprovados |
| `staging` | O que está em homologação | PR da `main`; o push constrói as imagens e implanta em homologação |
| `production` | O que está em produção | PR da `staging` com aprovação; o push promove a mesma imagem já validada |
| `feat/*`, `fix/*`, `docs/*` | Uma mudança por vez, no fork de quem contribui | Saem da `main` e voltam por PR |

O deploy na AWS fica desligado até a conta existir: defina a variável de repositório `DEPLOY_ENABLED=true` e os GitHub Environments `staging` e `production` conforme [`infra/README.md`](../infra/README.md). Até lá, um push em `staging` ou `production` não implanta nada.

## Site público no GitHub Pages

A versão estática do site (sem painel e sem servidor) é publicada pelo workflow [`pages.yml`](../.github/workflows/pages.yml) a cada mudança no site na `main`. Com o repositório público, ative em **Settings → Pages → Source: GitHub Actions**; o endereço fica `https://<dono>.github.io/malha/`. Para gerar localmente: `node scripts/build-static-site.mjs` (saída em `apps/site-static/out`). Nessa versão, "Entrar" e o cadastro apontam para o repositório: rodar o demo e pedir apoio por issue.

A imagem de prévia social do repositório fica em [`docs/media/marca/social-preview.png`](media/marca/social-preview.png): envie em **Settings → General → Social preview**.
