variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs"
  type        = list(string)
}

variable "general_node_min_size" {
  description = "Minimum nodes in general node group"
  type        = number
}

variable "general_node_max_size" {
  description = "Maximum nodes in general node group"
  type        = number
}

variable "general_node_desired_size" {
  description = "Desired nodes in general node group"
  type        = number
}

variable "spot_node_min_size" {
  description = "Minimum nodes in spot node group"
  type        = number
}

variable "spot_node_max_size" {
  description = "Maximum nodes in spot node group"
  type        = number
}

variable "spot_node_desired_size" {
  description = "Desired nodes in spot node group"
  type        = number
}

variable "common_tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default     = {}
}
