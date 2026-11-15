<p align="center">
  <img src="docs/media/readme-banner.svg" alt="Malha: inventário vivo de rede e ativos para grupos agrícolas. Open source e grátis, coletor UniFi somente leitura, Zabbix e Grafana montados do inventário." width="100%">
</p>

<p align="center">
  <a href="https://targino-tech.github.io/malha/"><b>Site</b></a> ·
  <a href="https://targino-tech.github.io/malha/video/"><b>Vídeo</b></a> ·
  <a href="#rode-o-demo"><b>Demo</b></a> ·
  <a href="docs/instalacao.md"><b>Instalação</b></a> ·
  <a href="docs/integracoes.md"><b>Integrações</b></a> ·
  <a href="CONTRIBUTING.md"><b>Contribuir</b></a>
</p>

<p align="center">
  <a href="https://github.com/targino-tech/malha/actions/workflows/ci.yml"><img src="https://github.com/targino-tech/malha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/targino-tech/malha/actions/workflows/security.yml"><img src="https://github.com/targino-tech/malha/actions/workflows/security.yml/badge.svg" alt="Segurança"></a>
  <a href="https://github.com/targino-tech/malha/actions/workflows/codeql.yml"><img src="https://github.com/targino-tech/malha/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/targino-tech/malha"><img src="https://api.scorecard.dev/projects/github.com/targino-tech/malha/badge" alt="OpenSSF Scorecard"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licen%C3%A7a-AGPL--3.0-b6f37a" alt="Licença AGPL-3.0"></a>
</p>

<a href="https://targino-tech.github.io/malha/video/"><img src="docs/media/video/previa.gif" alt="Prévia do vídeo do Malha: Mato Grosso com as fazendas de exemplo, queda de internet com alerta em 3 minutos, visão geral do parque tecnológico, Zabbix e Grafana e o final grátis e open source." width="100%"></a>

<p align="center"><sub>▶ <a href="https://targino-tech.github.io/malha/video/">Assistir ao vídeo completo com som (45 s)</a> · <a href="docs/media/video/malha-45s.mp4">baixar MP4</a></sub></p>

## O que é

O Malha mostra à matriz de um grupo agrícola, em um só painel, **quais fazendas estão reportando, quais ativos críticos merecem atenção e onde o cadastro diverge da rede real**. Um coletor em cada fazenda lê a controladora UniFi (somente leitura) e envia lotes assinados; o inventário entra por CSV ou pela interface. É grátis e open source, sem recurso bloqueado.

- **Alerta em 3 minutos** quando uma fazenda perde contato, com e-mail para os ativos críticos.
- **Parque tecnológico** com mapa das fazendas, painéis e conciliação entre cadastro e coleta.
- **Zabbix e Grafana** montados a partir do inventário, por arquivo ou direto pela API.
- **Login corporativo** com Entra ID, Active Directory/LDAP ou Google, Okta e Keycloak.
- **Dados isolados** por grupo no banco e restrição por fazenda para cada papel.

## Telas

| Visão geral | Painéis |
| --- | --- |
| <img src="docs/media/telas/visao-geral.webp" alt="Visão geral: parque tecnológico com 8 ativos em 3 fazendas, coletores em contato, críticos offline, ocorrências abertas e mapa das fazendas."> | <img src="docs/media/telas/paineis.webp" alt="Painéis: estado dos ativos por fazenda, ocorrências abertas por dia, tempo sem contato por coletor e ativos por categoria."> |
| **Ocorrências** | **Monitoramento** |
| <img src="docs/media/telas/ocorrencias.webp" alt="Ocorrências abertas com coletor sem contato e ativo offline, com botões de reconhecer e registrar atendimento."> | <img src="docs/media/telas/monitoramento.webp" alt="Monitoramento: escolha entre Modelo Malha e Modelo base e prévia dos hosts por família com templates do Zabbix."> |

<sub>Dados de demonstração.</sub>

<a id="rode-o-demo"></a>

## Rode o demo

Requer Node.js 24. O demo usa dados fictícios e não precisa de banco externo.

```sh
npm install --global pnpm@12.18.0
pnpm install --frozen-lockfile
MALHA_MODE=demo pnpm dev
```

Abra [127.0.0.1:3000](http://127.0.0.1:3000) para o painel e [/site](http://127.0.0.1:3000/site) para o site. Com Docker: `docker build --target web -t malha-web .` e `docker run --rm -p 3000:3000 -e MALHA_MODE=demo -e MALHA_DEMO_DB=memory:// malha-web`.

Coletor, PostgreSQL, login corporativo e deploy estão no **[guia de instalação](docs/instalacao.md)**.

## Como funciona

<p align="center">
  <img src="docs/media/readme-topologia.svg" alt="Topologia: na fazenda, a controladora UniFi é lida pelo coletor Go, que guarda lotes em SQLite e envia por HTTPS 443 para o Malha, na AWS em São Paulo ou em um servidor próprio. A entrada HTTPS separa ingestão e painel. O Next.js grava no PostgreSQL com RLS e o worker aplica capturas, avalia regras e envia e-mails. O serviço web autentica pelo Entra ID, AD/LDAP ou OpenID Connect e publica hosts e painéis no Zabbix e no Grafana. A matriz acessa o painel no navegador." width="100%">
</p>

| Peça | Papel |
| --- | --- |
| [`collector/`](collector) | Coletor Go na fazenda: lê o UniFi só com GET, assina com Ed25519 e guarda 72 h de fila |
| [`apps/web/`](apps/web) | Painel, API, ingestão, login, Zabbix/Grafana, site e portal (Next.js 16) |
| [`apps/worker/`](apps/worker) | Capturas, regras de ocorrência a cada minuto, e-mail e retenção |
| [`packages/db/`](packages/db) | Migrações do PostgreSQL 17 com RLS por organização e CLI de administração |
| [`infra/`](infra) | Terraform opcional para AWS São Paulo |

Detalhes e garantias de segurança em [`docs/arquitetura.md`](docs/arquitetura.md).

## Integrações

**UniFi** · **CSV** · **Zabbix 7.0** · **Grafana** · **Entra ID** · **AD/LDAP** · **Google, Okta e Keycloak (OIDC)** · **SMTP/SES**. Como configurar cada uma está no [guia de integrações](docs/integracoes.md).

## Contribua

Toda ajuda conta: código, documentação, testes com o seu equipamento ou um modelo de monitoramento para um fabricante novo.

- [Como contribuir](CONTRIBUTING.md) e os critérios de pull request
- [Boas primeiras issues](https://github.com/targino-tech/malha/labels/boa%20primeira%20issue) e o [roadmap](ROADMAP.md)
- [Discussões](https://github.com/targino-tech/malha/discussions) para dúvidas e ideias
- [Código de conduta](CODE_OF_CONDUCT.md) e [governança](GOVERNANCE.md)

<a href="https://github.com/targino-tech/malha/graphs/contributors"><img src="https://contrib.rocks/image?repo=targino-tech/malha" alt="Pessoas que contribuíram com o Malha"></a>

## Segurança

Vulnerabilidades vão pelo **[relato privado do GitHub](https://github.com/targino-tech/malha/security/advisories/new)**, nunca por issue pública; veja a [política de segurança](SECURITY.md). Cada mudança passa por CodeQL, Semgrep, Gitleaks, ClamAV, auditoria de dependências e OpenSSF Scorecard.

> **Nunca exponha o modo demo na internet.** Ele entra como administrador sem login. Em qualquer instalação acessível por outras pessoas, use `MALHA_MODE=pilot`.

## Licença

Software livre sob a [GNU AGPL v3.0 ou posterior](LICENSE). Quem oferecer uma versão modificada como serviço pela rede deve disponibilizar o código-fonte dessa versão aos usuários dela.
