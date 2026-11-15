resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg${var.postgres_version}"
  family = "postgres${var.postgres_version}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

# Senha do usuário mestre gerenciada pelo RDS no Secrets Manager. O runtime usa um login próprio
# sem BYPASSRLS, criado após a migração com packages/db/runtime-grants.sql.
resource "aws_db_instance" "main" {
  identifier                            = local.name
  engine                                = "postgres"
  engine_version                        = var.postgres_version
  instance_class                        = var.db_instance_class
  allocated_storage                     = var.db_allocated_storage
  max_allocated_storage                 = var.db_allocated_storage * 4
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.main.arn
  db_name                               = "malha"
  username                              = "malha_admin"
  manage_master_user_password           = true
  master_user_secret_kms_key_id         = aws_kms_key.main.arn
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.database.id]
  parameter_group_name                  = aws_db_parameter_group.main.name
  multi_az                              = var.db_multi_az
  publicly_accessible                   = false
  backup_retention_period               = 14
  backup_window                         = "06:00-07:00"
  maintenance_window                    = "sun:07:30-sun:08:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-final"
  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.main.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
}

# Valores preenchidos fora do Terraform para não gravar segredos no estado.
locals {
  secret_names = {
    database_url       = "URL do login de runtime (malha_runtime) com sslmode=require"
    database_admin_url = "URL do papel administrativo usado só pela tarefa de migração"
    entra_secret       = "Client secret do aplicativo no Entra ID"
    auth_secret        = "MALHA_AUTH_SECRET com ao menos 32 bytes aleatórios"
    smtp_url           = "smtps://usuario:senha@email-smtp.sa-east-1.amazonaws.com:465"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secret_names
  name                    = "malha/${var.environment}/${replace(each.key, "_", "-")}"
  description             = each.value
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_ecr_repository" "app" {
  for_each             = toset(["web", "worker"])
  name                 = "malha/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Mantém as 40 imagens mais recentes para rollback"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 40 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_sesv2_email_identity" "mail" {
  email_identity         = var.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.mail.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_configuration_set" "mail" {
  configuration_set_name = local.name

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  reputation_options {
    reputation_metrics_enabled = true
  }
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = var.hosted_zone_id
  name    = "${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.mail_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}
