variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "instance_class" {
  description = "RDS instance class"
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

variable "storage_size" {
  description = "Storage size in GB"
  type        = number
}

variable "storage_max_size" {
  description = "Max storage size in GB"
  type        = number
}

variable "backup_retention_days" {
  description = "Backup retention period in days"
  type        = number
}

variable "enable_multi_az" {
  description = "Enable Multi-AZ deployment"
  type        = bool
}

variable "wal_archive_bucket_arn" {
  description = "ARN of the S3 bucket for WAL archiving"
  type        = string
}

variable "common_tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default     = {}
}
