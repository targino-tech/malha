# Infraestrutura AWS

Terraform do Malha em São Paulo (`sa-east-1`). Uma conta AWS por ambiente (`staging` e `production`), mesmo código, variáveis diferentes.

| Peça | Recurso |
| --- | --- |
| Borda | Route 53, ACM, ALB com TLS 1.3 e AWS WAF (regras gerenciadas e limite por IP) |
| Hosts | `app_domain` serve o painel; `ingest_domain` aceita só `/v1/collectors/*`. O painel responde 404 para `/v1/*` |
| Aplicação | ECS Fargate: serviço `web` (2 tarefas em zonas distintas), serviço `worker` e tarefa `migrate` |
| Dados | RDS PostgreSQL 17 cifrado com KMS, PITR de 14 dias, Multi-AZ em produção, `rds.force_ssl` |
| Segredos | Secrets Manager, criados vazios e preenchidos fora do Terraform |
| E-mail | SES com DKIM e supressão de bounces e reclamações |
| Imagens | ECR imutável, varredura no push, retenção de 40 versões |
| Operação | CloudWatch Logs, alarmes de ALB, RDS e métricas do worker (EMF), SNS por e-mail e AWS Budgets em 50/80/100% |
| Deploy | Provedor OIDC do GitHub e papel restrito ao repositório e ao GitHub Environment |

## Primeira aplicação

1. Crie o bucket de estado (versionado e cifrado) e copie `envs/<ambiente>.backend.hcl.example` e `envs/<ambiente>.tfvars.example` sem o sufixo `.example`.
2. Aplique com `bootstrap = true`, que mantém os serviços em zero:

   ```sh
   terraform -chdir=infra init -backend-config=envs/staging.backend.hcl
   terraform -chdir=infra apply -var-file=envs/staging.tfvars
   ```

3. Preencha os segredos listados em `secrets_to_fill` (`aws secretsmanager put-secret-value`). A URL administrativa usa o usuário `malha_admin` (senha em `database_master_secret_arn`). Depois da primeira migração, aplique `packages/db/runtime-grants.sql`, crie o login do runtime com `GRANT malha_runtime` e preencha `database-url` com ele.
4. No GitHub, crie o Environment com o nome do ambiente e as variáveis `AWS_DEPLOY_ROLE_ARN`, `ECS_SUBNETS`, `ECS_SECURITY_GROUP`, `APP_DOMAIN` e `INGEST_DOMAIN` (saídas do Terraform). Em `production`, exija revisores.
5. Rode o workflow **Deploy** em `staging`. Ele publica as imagens, migra o banco, atualiza os serviços e faz o smoke test.
6. Troque para `bootstrap = false` e aplique de novo.

## Promoção e retorno

- Produção recebe o mesmo digest validado em homologação: rode **Deploy** em `production` com `image_tag` igual ao commit implantado em `staging`.
- O ECS usa circuit breaker com rollback automático. Para voltar manualmente, rode **Deploy** com a tag anterior. Migrações são aditivas: remova estruturas obsoletas só em um deploy seguinte.
- Restauração do banco: PITR do RDS em instância nova, ensaiada em ambiente isolado antes do piloto (metas RPO 15 min e RTO 4 h).

## Fora deste módulo

- SQS: o piloto usa a outbox no PostgreSQL com `FOR UPDATE SKIP LOCKED`, suficiente para o volume de 2 a 3 fazendas.
- Site público em CloudFront e S3: hoje o site sai do mesmo serviço web, em `/site`.
- Credenciais SMTP do SES: gere no console do SES e grave em `smtp-url`. Elas não passam pelo estado do Terraform.
- Tracing distribuído com OpenTelemetry: os logs são JSON estruturado e as métricas de operação saem em EMF.
