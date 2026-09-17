variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "node_type" {
  description = "ElastiCache node type"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "database_subnet_ids" {
  description = "Database subnet IDs"
  type        = list(string)
}

variable "eks_security_group_id" {
  description = "EKS node security group ID"
  type        = string
}

variable "shard_count" {
  description = "Number of shards"
  type        = number
}

variable "replicas_per_shard" {
  description = "Number of replicas per shard"
  type        = number
}

variable "enable_multi_az" {
  description = "Enable Multi-AZ deployment"
  type        = bool
}

variable "common_tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default     = {}
}
