variable "environment" {
  description = "Deployment environment (dev, staging, production)"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "Environment must be dev, staging, or production."
  }
}

variable "aws_region" {
  description = "AWS region for resource deployment"
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
  default     = "egaop-dev"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.r6g.large"
}

variable "enable_multi_az" {
  description = "Enable Multi-AZ for RDS and ElastiCache"
  type        = bool
  default     = true
}

variable "kubernetes_version" {
  description = "Kubernetes version for EKS"
  type        = string
  default     = "1.30"
}

variable "general_node_min_size" {
  description = "Minimum nodes in general node group"
  type        = number
  default     = 2
}

variable "general_node_max_size" {
  description = "Maximum nodes in general node group"
  type        = number
  default     = 10
}

variable "general_node_desired_size" {
  description = "Desired nodes in general node group"
  type        = number
  default     = 3
}

variable "spot_node_min_size" {
  description = "Minimum nodes in spot node group"
  type        = number
  default     = 0
}

variable "spot_node_max_size" {
  description = "Maximum nodes in spot node group"
  type        = number
  default     = 5
}

variable "spot_node_desired_size" {
  description = "Desired nodes in spot node group"
  type        = number
  default     = 2
}

variable "rds_storage_size" {
  description = "RDS storage size in GB"
  type        = number
  default     = 100
}

variable "rds_storage_max_size" {
  description = "RDS max storage size in GB"
  type        = number
  default     = 500
}

variable "rds_backup_retention_days" {
  description = "RDS backup retention period in days"
  type        = number
  default     = 7
}

variable "redis_shard_count" {
  description = "Number of Redis shards"
  type        = number
  default     = 1
}

variable "redis_replicas_per_shard" {
  description = "Number of Redis replicas per shard"
  type        = number
  default     = 2
}

variable "common_tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}
