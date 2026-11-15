variable "environment" {
  description = "Nome do ambiente: staging ou production. Use contas AWS separadas."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use staging ou production."
  }
}

variable "region" {
  description = "Região AWS. O piloto roda em São Paulo."
  type        = string
  default     = "sa-east-1"
}

variable "hosted_zone_id" {
  description = "Zona Route 53 que contém os domínios do app e da ingestão."
  type        = string
}

variable "app_domain" {
  description = "Host do painel autenticado, por exemplo app.malha.com.br."
  type        = string
}

variable "ingest_domain" {
  description = "Host exclusivo da ingestão dos coletores, por exemplo ingest.malha.com.br."
  type        = string
}

variable "mail_domain" {
  description = "Domínio verificado no SES para o e-mail operacional."
  type        = string
}

variable "entra_tenant_id" {
  description = "Diretório Entra ID do cliente piloto."
  type        = string
}

variable "entra_client_id" {
  description = "Client ID do aplicativo Malha no Entra ID."
  type        = string
}

variable "alert_email" {
  description = "Destinatário dos alarmes de plataforma e do orçamento."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Orçamento mensal da conta, com alertas em 50%, 80% e 100%."
  type        = number
  default     = 400
}

variable "vpc_cidr" {
  type    = string
  default = "10.60.0.0/16"
}

variable "single_nat_gateway" {
  description = "Um NAT para o ambiente inteiro. Desligue em produção para um NAT por zona."
  type        = bool
  default     = true
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  description = "RDS Multi-AZ. Obrigatório na produção do piloto."
  type        = bool
  default     = false
}

variable "postgres_version" {
  description = "Versão principal do PostgreSQL. Confirme o patch disponível em sa-east-1 no provisionamento."
  type        = string
  default     = "17"
}

variable "web_desired_count" {
  description = "Tarefas do serviço web. Duas, em zonas distintas, no piloto."
  type        = number
  default     = 2
}

variable "bootstrap" {
  description = "Na primeira aplicação, mantém os serviços em zero até o pipeline publicar as imagens."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "Repositório autorizado a implantar via OIDC, no formato dono/nome."
  type        = string
  default     = "targino-tech/malha"
}

variable "create_github_oidc_provider" {
  description = "Cria o provedor OIDC do GitHub na conta. Desligue se a conta já tiver um."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 90
}
