terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Configuração parcial: informe bucket, key e região com -backend-config=envs/<ambiente>.backend.hcl.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "malha"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
