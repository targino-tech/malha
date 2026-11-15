output "app_url" {
  value = "https://${var.app_domain}"
}

output "ingest_url" {
  value = "https://${var.ingest_domain}"
}

output "deploy_role_arn" {
  description = "Configure como a variável AWS_DEPLOY_ROLE_ARN do GitHub Environment."
  value       = aws_iam_role.deploy.arn
}

output "ecr_repositories" {
  value = { for key, repository in aws_ecr_repository.app : key => repository.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "task_families" {
  value = {
    web     = aws_ecs_task_definition.web.family
    worker  = aws_ecs_task_definition.worker.family
    migrate = aws_ecs_task_definition.migrate.family
  }
}

output "private_subnets" {
  description = "Sub-redes da tarefa de migração (variável ECS_SUBNETS do GitHub Environment)."
  value       = join(",", aws_subnet.private[*].id)
}

output "task_security_group" {
  description = "Security group da tarefa de migração (variável ECS_SECURITY_GROUP)."
  value       = aws_security_group.tasks.id
}

output "database_endpoint" {
  value = aws_db_instance.main.address
}

output "database_master_secret_arn" {
  description = "Segredo gerenciado pelo RDS com a senha do usuário malha_admin."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "secrets_to_fill" {
  description = "Segredos criados vazios. Preencha os valores com put-secret-value antes do primeiro deploy."
  value       = { for key, secret in aws_secretsmanager_secret.app : key => secret.name }
}
