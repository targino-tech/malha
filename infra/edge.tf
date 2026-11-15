resource "aws_acm_certificate" "main" {
  domain_name               = var.app_domain
  subject_alternative_names = [var.ingest_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate" {
  for_each = {
    for option in aws_acm_certificate.main.domain_validation_options : option.domain_name => option
  }
  zone_id         = var.hosted_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate : record.fqdn]
}

resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"
  idle_timeout               = 60
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"Recurso indisponível.\"}"
      status_code  = "404"
    }
  }
}

# A ingestão só aceita as rotas do coletor no host dedicado.
resource "aws_lb_listener_rule" "ingest" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    host_header {
      values = [var.ingest_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/v1/collectors/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# O host do painel não expõe as rotas de coleta.
resource "aws_lb_listener_rule" "app_blocks_ingest" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  condition {
    host_header {
      values = [var.app_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/v1/*"]
    }
  }

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"Recurso indisponível.\"}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "app" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  condition {
    host_header {
      values = [var.app_domain]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_route53_record" "hosts" {
  for_each = toset([var.app_domain, var.ingest_domain])
  zone_id  = var.hosted_zone_id
  name     = each.value
  type     = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_wafv2_web_acl" "main" {
  name  = local.name
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "regras-comuns"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # Lotes do coletor chegam a 1 MiB e importações a 5 MiB; a aplicação impõe os limites.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-comuns"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "entradas-maliciosas"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-entradas"
      sampled_requests_enabled   = true
    }
  }

  # Limite por IP permissivo: várias fazendas podem sair pelo mesmo NAT. Cotas finas ficam na aplicação.
  rule {
    name     = "limite-por-ip"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 3000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-limite"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "main" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
