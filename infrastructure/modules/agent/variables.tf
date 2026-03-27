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
  type = string
}

variable "aws_profile" {
  type    = string
  default = null
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "kvs_channel_name" {
  type    = string
  default = "voice-agent-webrtc"
}

variable "anam_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "anam_avatar_id" {
  type    = string
  default = ""
}
