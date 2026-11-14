# Arquitetura do primeiro corte

O painel e a API executam no mesmo processo Next.js. O worker consome a outbox do PostgreSQL no modo piloto. O coletor Go executa em cada fazenda, consulta apenas a API oficial local do UniFi e inicia todas as conexões com o Malha.

| Peça | Responsabilidade |
| --- | --- |
| `apps/web/src/app` | Interface e rotas HTTP |
| `apps/web/src/server` | Autorização, inventário, importação e ingestão |
| `packages/db` | Schema, migração e comandos administrativos |
| `apps/worker` | Aplicação das capturas aceitas |
| `collector` | API UniFi, assinatura Ed25519, coleta e fila persistente |

## Regras operacionais

- **Importação.** O operador escolhe uma fazenda, valida o cabeçalho e as linhas e conclui com confirmação explícita. O lote é vinculado à organização e ao operador. Os resultados aparecem no inventário e no resumo da fazenda.
- **Coleta.** Uma consulta bem-sucedida reúne os dispositivos adotados do site, inclusive todas as páginas. O coletor assina heartbeat e lotes. A API confirma o aceite após persistir o lote. Capturas parciais aguardam as partes restantes e mensagens repetidas usam a mesma identidade lógica.
- **Saúde.** Heartbeat de 60 s e leitura de inventário a cada 5 min. Três minutos sem heartbeat sinalizam falta de contato. Uma observação vencida ou obtida por um coletor anterior fica indeterminada. Ativos manuais permanecem visíveis sem alegação de telemetria.
- **Isolamento.** O escopo de ingestão vem da chave cadastrada. O acesso humano do piloto é vinculado a um diretório Entra e a uma associação local. Use credenciais distintas e de menor privilégio para runtime, worker e migração antes de expor um piloto.

## Antes de um piloto em campo

Homologue a rota local e a versão para cada modelo de console UniFi. Teste registro e revogação de um coletor, HTTPS e IAM com o diretório do cliente. Dimensione retenção, limites e spool com o número de ativos e faça um ensaio de 24 h sem WAN. Verifique recuperação do PostgreSQL e ajuste os papéis das fazendas. A arquitetura prevista para ECS Fargate, WAF, S3, SQS, SES e deploy com OIDC exige provisionamento próprio.

A documentação da API da própria console é a referência para o prefixo `/integration/v1`, paginação e campos da versão instalada. [Introdução à API oficial da Ubiquiti](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
