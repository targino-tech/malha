# Arquitetura do primeiro corte

O painel e a API executam no mesmo processo Next.js. O worker consome a outbox do PostgreSQL no modo piloto. O coletor Go executa em cada fazenda, consulta apenas a API oficial local do UniFi e inicia todas as conexões com o Malha.

| Peça | Responsabilidade |
| --- | --- |
| `apps/web/src/app` | Interface e rotas HTTP |
| `apps/web/src/server` | Autorização, inventário, importação e ingestão |
| `packages/db` | Schema, migração e comandos administrativos |
| `apps/worker` | Aplicação das capturas aceitas, avaliação de ocorrências e e-mail de alertas |
| `collector` | API UniFi, assinatura Ed25519, coleta e fila persistente |

## Regras operacionais

- **Importação.** O operador escolhe uma fazenda, valida o cabeçalho e as linhas e conclui com confirmação explícita. O lote é vinculado à organização e ao operador. Os resultados aparecem no inventário e no resumo da fazenda.
- **Coleta.** Uma consulta bem-sucedida reúne os dispositivos adotados do site, inclusive todas as páginas. O coletor assina heartbeat e lotes. A API confirma o aceite após persistir o lote. Capturas parciais aguardam as partes restantes e mensagens repetidas usam a mesma identidade lógica.
- **Saúde.** Heartbeat de 60 s e leitura de inventário a cada 5 min. Três minutos sem heartbeat sinalizam falta de contato. Uma observação vencida ou obtida por um coletor anterior fica indeterminada. Ativos manuais permanecem visíveis sem alegação de telemetria.
- **Ocorrências.** O worker avalia as regras a cada minuto com lock transacional como lease. Há um episódio aberto por fazenda, regra e recurso: coletor sem contato (crítica, após 3 min), coleta UniFi desatualizada (aviso, após 15 min), ativo offline confirmado (crítica quando o ativo é crítico) e divergência após 3 capturas completas sem um ativo antes observado. Regras de ativo exigem coletor em contato, então a perda de contato suprime alertas individuais. Uma observação online recente encerra o episódio do ativo. Reconhecer registra operador e horário na trilha de auditoria.
- **Alertas por e-mail.** Só ocorrências críticas geram notificação, com chave única por ocorrência e destinatário. O envio agrupa por destinatário e fazenda, descarta episódios já encerrados e suprime ativos enquanto a fazenda estiver sem contato.
- **Acesso.** Admin gerencia fazendas, membros e coletores. TI e técnico operam inventário, importações e ocorrências; o técnico só nas fazendas atribuídas e os demais papéis opcionalmente restritos por `membership_farms`. Diretoria e auditor leem. Fazendas fora do escopo respondem 404 em leituras e escritas, e listas, agregados e ocorrências filtram pelo mesmo escopo.
- **Inventário.** A listagem pagina no servidor por cursor (nome, id) com busca e filtros. O estado exibido deriva da observação recente do coletor ativo. Ativos manuais têm local técnico, responsável e janela de manutenção; a manutenção suspende e-mails e o arquivamento encerra episódios do ativo. Toda mutação gera registro de auditoria.
- **Histórico e retenção.** Cada captura completa grava uma observação por ativo conhecido, inclusive reenvios atrasados, sem alterar o estado atual. O worker remove observações e lotes brutos com mais de 30 dias a cada hora. A auditoria não é apagada pelo runtime.
- **Conciliação.** Descobertas UniFi sem cadastro, vínculos automáticos por MAC e itens de referência ficam em filas até o técnico confirmar. Vincular funde a descoberta no item do cadastro e transfere o histórico. Desfazer um vínculo registra o identificador rejeitado para que a projeção não volte a ligá-lo.
- **Indicadores.** Cobertura UniFi, inventário conferido, mediana e P90 da detecção, mediana do reconhecimento e economia a partir de atendimentos reais e da linha de base aprovada pelo cliente. Amostras vazias mostram “Sem dados”.
- **Operação.** `/api/health` verifica o banco para o ALB. Logs saem em JSON de uma linha, sem payloads ou dados pessoais. O worker publica a cada minuto métricas em Embedded Metric Format (fila de saída, coletores sem contato, idade da coleta, desvio de relógio e e-mails com falha), com alarmes definidos em `infra/`. O desvio de relógio do coletor vem do `iat` da prova assinada.
- **Entrega.** Imagens `web` e `worker` saem do mesmo `Dockerfile`. O CI constrói e sobe a imagem web em modo demo e valida o Terraform. O workflow **Deploy** publica com SBOM e proveniência, migra em tarefa dedicada, atualiza o ECS e faz smoke test. Releases do coletor (`collector-vX.Y.Z`) saem assinadas pelo Sigstore e `collector/deploy/update.sh` instala com verificação e retorno automático.
- **Isolamento.** O escopo de ingestão vem da chave cadastrada. O acesso humano é vinculado a uma associação local do grupo, por Entra ID, AD/LDAP ou OpenID Connect (convite por e-mail). Use credenciais distintas e de menor privilégio para runtime, worker e migração antes de expor um piloto.

## Antes de um piloto em campo

Homologue a rota local e a versão para cada modelo de console UniFi. Teste registro e revogação de um coletor, HTTPS e IAM com o diretório do cliente. Dimensione retenção, limites e spool com o número de ativos e faça um ensaio de 24 h sem WAN. Verifique recuperação do PostgreSQL e ajuste os papéis das fazendas. A arquitetura prevista para ECS Fargate, WAF, S3, SQS, SES e deploy com OIDC exige provisionamento próprio.

A documentação da API da própria console é a referência para o prefixo `/integration/v1`, paginação e campos da versão instalada. [Introdução à API oficial da Ubiquiti](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
