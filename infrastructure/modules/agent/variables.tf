variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "knowledge_base_id" {
  type = string
}

variable "agent_source_dir" {
  description = "Path to the agent source directory (contains Dockerfile)"
  type        = string
}

variable "aws_profile" {
  description = "AWS CLI profile for Docker push"
  type        = string
  default     = null
}
