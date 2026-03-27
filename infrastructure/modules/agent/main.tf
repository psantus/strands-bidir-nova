data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Content hash - triggers rebuild when source files change
# -----------------------------------------------------------------------------

locals {
  src_hash  = sha1(join("", [for f in sort(fileset(var.agent_source_dir, "**/*.{py,txt}")) : filesha1("${var.agent_source_dir}/${f}")]))
  image_tag = "src-${local.src_hash}"
}

# -----------------------------------------------------------------------------
# ECR repository
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "agent" {
  name                 = "${var.project_name}-${var.environment}-agent"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "agent" {
  repository = aws_ecr_repository.agent.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# -----------------------------------------------------------------------------
# Docker build + push
# -----------------------------------------------------------------------------

resource "terraform_data" "docker_push" {
  triggers_replace = local.image_tag

  provisioner "local-exec" {
    environment = { AWS_PROFILE = var.aws_profile != null ? var.aws_profile : "" }
    command = <<-EOF
      set -e
      SRC="$(cd "${var.agent_source_dir}" && pwd)"
      REGISTRY="${aws_ecr_repository.agent.repository_url}"
      REGION="${var.aws_region}"
      docker build --platform linux/arm64 \
        --build-arg BEDROCK_KB_ID="${var.knowledge_base_id}" \
        -t "$REGISTRY:${local.image_tag}" \
        -f "$SRC/Dockerfile" "$SRC"
      aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "$(echo $REGISTRY | cut -d/ -f1)"
      docker push "$REGISTRY:${local.image_tag}"
    EOF
  }
}

# -----------------------------------------------------------------------------
# IAM role for AgentCore runtime
# -----------------------------------------------------------------------------

resource "aws_iam_role" "agentcore" {
  name = "${var.project_name}-${var.environment}-agentcore"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "agentcore" {
  name = "agentcore-permissions"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*",
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*",
        ]
      },
      {
        Sid      = "XRay"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
        Resource = "*"
      },
      {
        Sid       = "CloudWatchMetrics"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "bedrock-agentcore" } }
      },
      {
        Sid    = "WorkloadIdentity"
        Effect = "Allow"
        Action = ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"]
        Resource = [
          "arn:aws:bedrock-agentcore:*:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default",
          "arn:aws:bedrock-agentcore:*:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default/workload-identity/*",
        ]
      },
      {
        Sid      = "NovaSonicAccess"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModelWithBidirectionalStream"]
        Resource = ["arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.nova-2-sonic-v1*"]
      },
      {
        Sid      = "KnowledgeBaseAccess"
        Effect   = "Allow"
        Action   = ["bedrock:Retrieve"]
        Resource = ["arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:knowledge-base/${var.knowledge_base_id}"]
      },
      {
        Sid      = "ECRImageAccess"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = [aws_ecr_repository.agent.arn]
      },
      {
        Sid      = "ECRTokenAccess"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "KVSAccess"
        Effect = "Allow"
        Action = [
          "kinesisvideo:DescribeSignalingChannel",
          "kinesisvideo:GetSignalingChannelEndpoint",
          "kinesisvideo:GetIceServerConfig",
          "kinesisvideo:ConnectAsMaster",
          "kinesisvideo:CreateSignalingChannel",
        ]
        Resource = "*"
      },
      {
        Sid    = "VPCNetworking"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeVpcs",
        ]
        Resource = "*"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# AgentCore Runtime (Docker / VPC / WebRTC)
# -----------------------------------------------------------------------------

resource "aws_bedrockagentcore_agent_runtime" "this" {
  agent_runtime_name = replace("${var.project_name}_${var.environment}_voice_agent", "-", "_")
  role_arn           = aws_iam_role.agentcore.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${aws_ecr_repository.agent.repository_url}:${local.image_tag}"
    }
  }

  environment_variables = {
    KVS_CHANNEL_NAME = var.kvs_channel_name
    AWS_REGION       = var.aws_region
    BEDROCK_KB_ID    = var.knowledge_base_id
    CONTAINER_ENV    = "true"
  }

  network_configuration {
    network_mode = "VPC"

    vpc_configuration {
      subnet_ids         = var.private_subnet_ids
      security_group_ids = [var.security_group_id]
    }
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  depends_on = [
    aws_iam_role_policy.agentcore,
    terraform_data.docker_push,
  ]
}
