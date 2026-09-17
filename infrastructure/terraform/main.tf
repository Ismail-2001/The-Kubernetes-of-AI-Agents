locals {
  name_prefix = "egaop-${var.environment}"

  common_tags = merge(
    {
      Environment = var.environment
      Project     = "egaop"
      ManagedBy   = "terraform"
    },
    var.common_tags
  )
}

module "vpc" {
  source = "./modules/vpc"

  name_prefix    = local.name_prefix
  environment    = var.environment
  vpc_cidr       = var.vpc_cidr
  aws_region     = var.aws_region
  common_tags    = local.common_tags
}

module "eks" {
  source = "./modules/eks"

  name_prefix              = local.name_prefix
  environment              = var.environment
  cluster_name             = var.cluster_name
  kubernetes_version       = var.kubernetes_version
  vpc_id                   = module.vpc.vpc_id
  private_subnet_ids       = module.vpc.private_subnet_ids
  general_node_min_size    = var.general_node_min_size
  general_node_max_size    = var.general_node_max_size
  general_node_desired_size = var.general_node_desired_size
  spot_node_min_size       = var.spot_node_min_size
  spot_node_max_size       = var.spot_node_max_size
  spot_node_desired_size   = var.spot_node_desired_size
  common_tags              = local.common_tags
}

module "rds" {
  source = "./modules/rds"

  name_prefix              = local.name_prefix
  environment              = var.environment
  instance_class           = var.rds_instance_class
  vpc_id                   = module.vpc.vpc_id
  database_subnet_ids      = module.vpc.database_subnet_ids
  eks_security_group_id    = module.eks.node_security_group_id
  storage_size             = var.rds_storage_size
  storage_max_size         = var.rds_storage_max_size
  backup_retention_days    = var.rds_backup_retention_days
  enable_multi_az          = var.enable_multi_az
  wal_archive_bucket_arn   = module.s3.wal_archive_bucket_arn
  common_tags              = local.common_tags
}

module "elasticache" {
  source = "./modules/elasticache"

  name_prefix              = local.name_prefix
  environment              = var.environment
  node_type                = var.redis_node_type
  vpc_id                   = module.vpc.vpc_id
  database_subnet_ids      = module.vpc.database_subnet_ids
  eks_security_group_id    = module.eks.node_security_group_id
  shard_count              = var.redis_shard_count
  replicas_per_shard       = var.redis_replicas_per_shard
  enable_multi_az          = var.enable_multi_az
  common_tags              = local.common_tags
}

module "s3" {
  source = "./modules/s3"

  name_prefix = local.name_prefix
  environment = var.environment
  rds_role_arn = module.rds.wal_upload_role_arn
  common_tags  = local.common_tags
}
