# Como contribuir com o Malha

Obrigado por querer ajudar! O Malha é open source sob a [AGPL-3.0-or-later](LICENSE). Ao enviar uma contribuição, você concorda em licenciá-la nos mesmos termos. Todos seguem o [código de conduta](CODE_OF_CONDUCT.md).

## Jeitos de ajudar (nem todos são código)

- **Responder dúvidas** nas [discussões](https://github.com/targino-tech/malha/discussions).
- **Testar** com o seu UniFi, Zabbix, Grafana, AD ou provedor OIDC e contar o que funcionou ou não.
- **Melhorar a documentação**: README, [integrações](docs/integracoes.md), exemplos de CSV.
- **Criar modelos de monitoramento** para novos fabricantes no catálogo (`apps/web/src/server/catalog.ts`).
- **Corrigir erros e implementar funcionalidades**: comece pelas issues com o rótulo [`boa primeira issue`](https://github.com/targino-tech/malha/labels/boa%20primeira%20issue) ou [`ajuda bem-vinda`](https://github.com/targino-tech/malha/labels/ajuda%20bem-vinda).
- **Traduzir** textos da interface e do site.

Vulnerabilidades **não** vão em issue pública: siga a [política de segurança](SECURITY.md).

## Antes de começar

- Para mudanças grandes, abra uma issue ou uma [discussão de ideia](https://github.com/targino-tech/malha/discussions/categories/ideas) antes do código. Assim ninguém perde trabalho.
- Comente na issue que vai pegá-la, para evitar trabalho duplicado.
- Leia o [AGENTS.md](AGENTS.md). As regras valem para pessoas e agentes de IA:
  - preservar o escopo de grupo e fazenda em rotas, consultas, exportações e agregados;
  - manter o coletor somente leitura e verificar requisições assinadas, com idempotência e frescor;
  - mostrar uma ligação porta a porta só quando a evidência identifica as duas pontas;
  - no site, descrever só o que já existe, marcar dados fictícios e funcionar com teclado, tela estreita e movimento reduzido.

## Ambiente

Requisitos: Node.js 24 (`.node-version`), pnpm 12.18, Go 1.27 (para o coletor) e Docker (opcional, para PostgreSQL).

```sh
git clone https://github.com/<seu-usuario>/malha.git
cd malha
npm install --global pnpm@12.18.0
pnpm install --frozen-lockfile
MALHA_MODE=demo pnpm dev   # demo com dados fictícios em http://127.0.0.1:3000
```

O modo demo usa PGlite em memória e não precisa de banco externo. Mais opções no [guia de instalação](docs/instalacao.md).

## Fluxo de trabalho

1. Faça um fork e crie uma branch a partir da `main`: `feat/mapa-por-talhao`, `fix/csv-acentos`, `docs/integracao-okta`.
2. Faça commits pequenos, com mensagem no imperativo e em português, como no histórico: `Adiciona filtro por fabricante no parque`.
   Para fechar uma issue pelo commit ou pelo pull request, use a palavra-chave em inglês, que é a única que o GitHub reconhece: `Closes #12`, `Fixes #12` ou `Resolves #12` ("Fecha #12" só cria a menção, não fecha).
3. Rode as verificações abaixo.
4. Abra o pull request para a `main` preenchendo o modelo. Pull requests em rascunho são bem-vindos para pedir opinião cedo.

`staging` e `production` são só de entrega: a manutenção promove a `main` para elas por PR. Contribuições sempre vão para a `main`.

### Verificações locais

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e              # precisa do Chromium do Playwright: pnpm exec playwright install chromium
cd collector && go test ./...
```

## Critérios para aceitar um pull request

Todo pull request precisa:

- [ ] Passar em todos os checks obrigatórios: **CI** (web, banco e navegador; coletor Go; imagens Docker; Terraform), **Segurança** (dependências, Semgrep, Gitleaks, ClamAV), **CodeQL** e **revisão de dependências**.
- [ ] Ter a aprovação de pelo menos um mantenedor (CODEOWNERS) e todas as conversas resolvidas.
- [ ] Incluir testes para regras de negócio e para todo caminho que leia ou altere dados de outro grupo ou fazenda.
- [ ] Não reduzir o escopo de segurança: nada de `BYPASSRLS`, de consulta sem `org_id` ou de escrita no coletor.
- [ ] Não incluir segredos, dados reais de clientes, IPs ou nomes de fazendas reais (use os dados fictícios do demo).
- [ ] Atualizar a documentação quando mudar comportamento, configuração ou variáveis de ambiente.
- [ ] Para mudanças visuais: funcionar com teclado, em tela estreita, com movimento reduzido e em tema escuro; anexar captura de tela.
- [ ] Para novas dependências: justificar no pull request; licença compatível com a AGPL-3.0 (MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL, GPL).

A manutenção pode pedir ajustes. Pull requests sem atividade por 30 dias depois de um pedido de mudança podem ser fechados, sempre com a porta aberta para reabrir.

## Rótulos

| Rótulo | Uso |
| --- | --- |
| `erro`, `funcionalidade`, `documentação`, `segurança`, `dependências`, `ci` | Tipo de mudança, também usado nas notas de release |
| `boa primeira issue`, `ajuda bem-vinda` | Bons pontos de entrada para quem chega |
| `área: web`, `área: coletor`, `área: banco`, `área: infra`, `área: site`, `área: monitoramento`, `área: login` | Onde a mudança acontece (aplicados automaticamente nos PRs) |
| `triagem` | Ainda não avaliado pela manutenção |

## Agentes de IA

Contribuições feitas com ajuda de IA são aceitas nas mesmas condições: quem abre o pull request é responsável pelo código, precisa entendê-lo e responder à revisão. As instruções para agentes ficam em [`AGENTS.md`](AGENTS.md) e [`.github/copilot-instructions.md`](.github/copilot-instructions.md).
