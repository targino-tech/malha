# Política de segurança do Malha

O Malha guarda inventário de rede, credenciais de integração e dados de várias empresas no mesmo serviço. Levamos relatos de segurança a sério e agradecemos quem ajuda a proteger os usuários.

## Versões atendidas

| Versão | Correções de segurança |
| --- | --- |
| `main` (mais recente) | Sim |
| Release mais recente do coletor | Sim |
| Revisões e releases anteriores | Não: atualize para a mais recente |

Ao relatar, informe o SHA ou a versão usada e se o problema também ocorre na `main` atual.

## Como relatar uma vulnerabilidade

**Não abra issue, discussão ou pull request público para vulnerabilidades.**

Use o relato privado do GitHub: **[Reportar uma vulnerabilidade](https://github.com/targino-tech/malha/security/advisories/new)** (aba *Security* → *Report a vulnerability*). Só a manutenção vê o relato, e a correção pode ser preparada em um fork privado antes de ser publicada.

Inclua:

- Componente afetado (painel web, ingestão `/v1`, worker, coletor, Terraform, workflows) e versão ou SHA.
- Pré-requisitos, passos mínimos para reproduzir e impacto observado.
- Evidência mínima, com credenciais, dados de clientes, IPs e identificadores sensíveis removidos.
- Se há credencial exposta ou exploração em andamento, sem incluir os valores.

## O que tratamos como vulnerabilidade

- Leitura ou alteração de dados de **outro grupo** (organização) ou de uma **fazenda fora do escopo** do usuário.
- Contorno de login (Entra ID, AD/LDAP, OpenID Connect), de sessão ou de permissão por papel.
- Aceitar requisições do coletor sem assinatura válida, reutilizar provas (replay) ou quebrar a idempotência das capturas.
- O coletor executar qualquer escrita na controladora UniFi (ele deve ser somente leitura).
- Vazamento de tokens de integração (Zabbix, Grafana), da senha da conta de serviço LDAP ou de segredos da infraestrutura.
- SSRF, injeção (SQL, LDAP, fórmulas em CSV), XSS ou execução remota de código.
- Workflows do GitHub que permitam a terceiros obter tokens ou publicar artefatos.

Fora do escopo: dados fictícios do modo demo, ausência de cabeçalhos sem impacto demonstrável, ataques que exigem acesso físico ou à conta do administrador, negação de serviço por volume e engenharia social.

## Tratamento do relato

1. A manutenção confirma o recebimento e avalia o impacto.
2. Combinamos com você o plano de correção e a data de divulgação.
3. A correção sai na `main` (e numa release do coletor, se for o caso) com um aviso de segurança (GitHub Security Advisory) e, quando cabível, um CVE.
4. Com sua permissão, damos crédito no aviso.

## Pesquisa de boa-fé

Teste apenas em instalações suas, como o modo demo (`MALHA_MODE=demo`) ou um piloto próprio. Não acesse, altere nem guarde dados de terceiros, não degrade serviços e pare assim que confirmar o problema. Pesquisa feita dentro destas regras é bem-vinda e não será tratada como ataque.

## Como o projeto se protege

- Análise automática a cada mudança: CodeQL, Semgrep, Gitleaks no histórico Git, ClamAV, auditoria de dependências (pnpm e govulncheck) e revisão de dependências nos pull requests.
- OpenSSF Scorecard semanal, Dependabot para npm, Go, Docker, Terraform e GitHub Actions, e Actions fixadas por SHA.
- No produto: RLS por organização no PostgreSQL, sessão revalidada a cada requisição, checagem de origem nas rotas de escrita, mensagens do coletor assinadas com Ed25519 e nonce de uso único, segredos de integração cifrados com AES-256-GCM.

Detalhes da arquitetura em [`docs/arquitetura.md`](docs/arquitetura.md).
