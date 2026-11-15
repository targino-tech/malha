resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["web", "worker", "migrate"])
  name              = "/malha/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "segredos"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [for secret in aws_secretsmanager_secret.app : secret.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.main.arn]
      },
    ]
  })
}

# Papéis distintos e sem permissões AWS: web e worker só falam com o banco, Entra ID e SMTP.
resource "aws_iam_role" "task" {
  for_each           = toset(["web", "worker"])
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

locals {
  registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  common_environment = [
    { name = "MALHA_MODE", value = "pilot" },
    { name = "MALHA_ENVIRONMENT", value = var.environment },
    { name = "MALHA_PUBLIC_ORIGIN", value = "https://${var.app_domain}" },
    { name = "ENTRA_TENANT_ID", value = var.entra_tenant_id },
    { name = "ENTRA_CLIENT_ID", value = var.entra_client_id },
    { name = "MALHA_ALERT_FROM", value = "Malha <alertas@${var.mail_domain}>" },
  ]
  secret = { for key, secret in aws_secretsmanager_secret.app : key => secret.arn }
  logs = { for key, group in aws_cloudwatch_log_group.app : key => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = group.name
      awslogs-region        = var.region
      awslogs-stream-prefix = key
    }
  } }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["web"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                   = "web"
    image                  = "${aws_ecr_repository.app["web"].repository_url}:bootstrap"
    essential              = true
    readonlyRootFilesystem = false
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    environment            = local.common_environment
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret.database_url },
      { name = "ENTRA_CLIENT_SECRET", valueFrom = local.secret.entra_secret },
      { name = "MALHA_AUTH_SECRET", valueFrom = local.secret.auth_secret },
    ]
    logConfiguration = local.logs.web
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["worker"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = "worker"
    image       = "${aws_ecr_repository.app["worker"].repository_url}:bootstrap"
    essential   = true
    environment = local.common_environment
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret.database_url },
      { name = "MALHA_SMTP_URL", valueFrom = local.secret.smtp_url },
    ]
    logConfiguration = local.logs.worker
  }])
}

# Migração como tarefa dedicada, com o papel administrativo, disparada pelo pipeline antes do deploy.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["worker"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = "${aws_ecr_repository.app["worker"].repository_url}:bootstrap"
    essential        = true
    command          = ["node", "dist/manage.js", "migrate"]
    secrets          = [{ name = "DATABASE_ADMIN_URL", valueFrom = local.secret.database_admin_url }]
    logConfiguration = local.logs.migrate
  }])
}

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.bootstrap ? 0 : var.web_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # O pipeline registra novas revisões com o digest da imagem.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.bootstrap ? 0 : 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}
