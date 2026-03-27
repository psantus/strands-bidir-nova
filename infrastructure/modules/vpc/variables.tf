variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "AZs to use (must be supported by AgentCore)"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1c"]
}
