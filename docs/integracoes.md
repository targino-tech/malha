# Guia de integrações

Como ligar o Malha ao que o seu grupo já usa. Tudo o que está aqui já funciona na `main`.

| Integração | Para quê | Onde configurar |
| --- | --- | --- |
| [Coletor UniFi](#coletor-unifi) | Observar a rede da fazenda (dispositivos, estado, MAC, IP) | Na fazenda, com código gerado em **Integrações** |
| [Planilha CSV](#planilha-csv) | Trazer o cadastro patrimonial que a equipe já mantém | **Importações** |
| [Zabbix e Grafana](#zabbix-e-grafana) | Montar o monitoramento a partir do inventário | **Monitoramento** |
| [Login corporativo](#login-corporativo) | Entrar com a conta da empresa | Variáveis de ambiente e CLI |
| [E-mail de alertas](#e-mail-de-alertas) | Avisar a TI sobre ativos críticos | Variáveis do worker |
| [Exportações](#exportações) | Levar inventário, ocorrências e auditoria para planilha | Botões de exportação no painel |

## Coletor UniFi

O coletor é um binário Go que roda num Linux da fazenda, lê a API local de Integrações do UniFi Network **somente com GET** e envia lotes assinados (Ed25519) para o Malha. A conexão sempre parte da fazenda: não é preciso abrir porta. Durante uma queda de internet, ele guarda até 72 horas de capturas em SQLite.

1. No painel, em **Integrações**, gere o código de ativação da fazenda (uso único).
2. Na console UniFi, crie uma chave de API local somente leitura.
3. Na máquina da fazenda, compile o coletor (`cd collector && go build -trimpath -o malha-collector .`) ou use uma [release assinada](https://github.com/targino-tech/malha/releases) quando houver uma tag `collector-v*` publicada, e siga o [`collector/README.md`](../collector/README.md): `sites` → `enroll` → `run` (há um serviço systemd de exemplo).
4. A primeira coleta aparece em **Integrações** em até 5 minutos; o heartbeat chega a cada 60 s.

Outros fabricantes (MikroTik, FortiGate) estão no [roadmap](../ROADMAP.md). O contrato de observações é o mesmo: veja [`docs/arquitetura.md`](arquitetura.md) se quiser propor um coletor novo.

## Planilha CSV

Em **Importações**, envie um CSV UTF-8 com cabeçalho. Colunas obrigatórias: `etiqueta`, `nome`, `categoria`. Opcionais: `criticidade` (`padrao` ou `critico`), `mac`, `ip`. Até 10 mil linhas por arquivo, com prévia e erro por linha antes de confirmar.

```csv
etiqueta,nome,categoria,criticidade,mac,ip
CAMPO-001,Coletor de cabine,Tablet,padrao,,
CAMPO-002,Balança de entradas,Balança,critico,,192.0.2.20
```

Exemplo completo em [`examples/inventario.csv`](../examples/inventario.csv). A `categoria` e o nome decidem a família do ativo no monitoramento (por exemplo, "Switch", "Ponto de acesso", "Servidor", "Câmera").

## Zabbix e Grafana

Em **Monitoramento**, o Malha monta um host do Zabbix por ativo com IP, agrupado por fazenda e por família, e um painel do Grafana por família. Escolha o modelo:

| Família | Modelo base | Modelo Malha |
| --- | --- | --- |
| Núcleo e roteamento, Acesso Wi-Fi | ICMP Ping | ICMP Ping + o template do fabricante: `Cisco IOS by SNMP`, `Huawei VRP by SNMP`, `FortiGate by SNMP`, `Mikrotik by SNMP`, `TP-LINK by SNMP` ou `Aruba CX 8300s by SNMP` (só a linha CX 8300); Intelbras, outras Aruba e o resto usam `Network Generic Device by SNMP` |
| Enlaces de rádio | ICMP Ping | ICMP Ping + `Ubiquiti AirOS by SNMP` ou genérico SNMP |
| Servidores, Controladores de domínio | ICMP Ping | ICMP Ping + `Windows by Zabbix agent` ou `Linux by Zabbix agent` |
| Estações de usuário | ICMP Ping | ICMP Ping + `Windows by Zabbix agent` (quando Windows) |
| Equipamentos de campo, Segurança física, Outros | ICMP Ping | ICMP Ping |

Os nomes são os técnicos dos templates que vêm no Zabbix 7.0 LTS, conferidos no repositório oficial (`zabbix/zabbix`, branch `release/7.0`, pasta `templates/`). O catálogo completo, com os painéis de cada família, aparece na própria tela de Monitoramento.

**Por arquivo:** baixe o JSON do Zabbix 7.0 (Coleta de dados → Hosts → Importar) e cada painel do Grafana (Dashboards → Importar). Reexportar mantém os mesmos ids: importar de novo atualiza em vez de duplicar.

**Pela API:** cadastre a URL `https://` e um token (no Zabbix, um token de API com permissão para criar hosts; no Grafana, uma conta de serviço com papel Editor e o plugin `alexanderzobnin-zabbix-app` com a fonte de dados criada). O token fica cifrado e nunca volta para a tela. Templates que não existirem no servidor caem para ICMP Ping, e o resultado mostra quais faltaram.

Para SNMP, defina a macro `{$SNMP_COMMUNITY}` no grupo ou globalmente. Para Windows e Linux, instale o Zabbix agent nos ativos.

> Quer um fabricante novo no catálogo? Os modelos ficam em [`apps/web/src/server/catalog.ts`](../apps/web/src/server/catalog.ts) (famílias e fabricantes) e [`apps/web/src/server/monitoring.ts`](../apps/web/src/server/monitoring.ts) (templates e painéis). Abra uma [issue de integração](https://github.com/targino-tech/malha/issues/new?template=integracao.yml) com o nome do template oficial do Zabbix.

## Login corporativo

| Provedor | Como configurar |
| --- | --- |
| Microsoft Entra ID | `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`; o membro entra pelo Object ID |
| Active Directory / LDAP | `pnpm db ldap …` ([guia de instalação](instalacao.md#login-por-active-directory-ou-ldap)); o membro entra pelo `objectGUID` ou `entryUUID` |
| Google Workspace, Okta, Keycloak e outros OpenID Connect | `MALHA_OIDC_*` ([guia de instalação](instalacao.md#login-por-google-workspace-okta-keycloak-ou-outro-openid-connect)); o membro entra pelo e-mail do convite |

Em todos, o acesso é por convite em **Administração**, com papel (admin, TI, técnico de fazenda, diretoria, auditor) e restrição por fazenda. A sessão dura até 8 horas e é revalidada a cada requisição: desativar o membro corta o acesso na hora.

## E-mail de alertas

O worker (`pnpm worker`) envia e-mail só para ocorrências de ativos críticos, agrupado por fazenda e sem duplicatas. Configure `MALHA_SMTP_URL` (o SMTP do Amazon SES serve) e `MALHA_ALERT_FROM`, e cadastre os destinatários com `pnpm db recipient <org-id> <email>`.

## Exportações

Inventário, ocorrências (evidências) e auditoria saem em dois formatos, sempre no escopo de fazendas de quem exporta e registrados na auditoria:

- **Planilha (XLSX)**: padronizada com a identidade do Malha. Traz no topo o grupo, o escopo, quem exportou e quando; cabeçalho e rodapé de impressão com os mesmos dados em todas as páginas; marca d'água "MALHA · USO INTERNO" ao fundo (visível no Excel); cabeçalho congelado, filtros e datas como datas. Todo texto é gravado como texto: nada vira fórmula.
- **CSV**: separador `;` (abre direto no Excel em português), com células que começam por fórmula neutralizadas.
