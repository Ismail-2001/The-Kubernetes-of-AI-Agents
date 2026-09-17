resource "aws_db_parameter_group" "main" {
  family = "postgres15"
  name   = "${var.name_prefix}-pg15-params"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pgvector"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "max_connections"
    value = "200"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = var.common_tags
}

resource "aws_security_group" "rds" {
  name_prefix = "${var.name_prefix}-rds-"
  description = "Security group for RDS PostgreSQL"
  vpc_id      = var.vpc_id

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-rds-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "rds_ingress_eks" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.eks_security_group_id
  security_group_id        = aws_security_group.rds.id
  description              = "Allow PostgreSQL from EKS nodes"
}

resource "aws_security_group_rule" "rds_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.rds.id
  description       = "Allow all outbound traffic"
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-db-subnet-group"
  subnet_ids = var.database_subnet_ids

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-db-subnet-group"
  })
}

resource "aws_kms_key" "rds" {
  description             = "KMS key for RDS encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-rds-kms"
  })
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = "${var.name_prefix}-pg"

  engine              = "aurora-postgresql"
  engine_version      = "15.4"
  database_name       = "egaop"
  master_username     = "egaop_admin"
  manage_master_user_password = true

  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  db_cluster_parameter_group_name = aws_db_cluster_parameter_group.main.name

  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = "03:00-04:00"
  preferred_maintenance_window = "sun:04:00-sun:05:00"

  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${var.name_prefix}-pg-final" : null
  deletion_protection       = var.environment == "production"

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-pg-cluster"
  })
}

resource "aws_db_cluster_parameter_group" "main" {
  family = "aurora-postgresql15"
  name   = "${var.name_prefix}-pg-cluster-params"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pgvector"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "max_connections"
    value = "200"
  }

  tags = var.common_tags
}

resource "aws_rds_cluster_instance" "main" {
  count = var.enable_multi_az ? 2 : 1

  identifier         = "${var.name_prefix}-pg-${count.index}"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = var.instance_class

  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version

  publicly_accessible = false

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.rds.arn

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-pg-instance-${count.index}"
  })
}

resource "aws_iam_role" "rds_wal_upload" {
  name = "${var.name_prefix}-rds-wal-upload-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "rds.amazonaws.com"
        }
      }
    ]
  })

  tags = var.common_tags
}

resource "aws_iam_role_policy" "rds_wal_upload" {
  name = "${var.name_prefix}-rds-wal-upload-policy"
  role = aws_iam_role.rds_wal_upload.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Effect   = "Allow"
        Resource = [
          var.wal_archive_bucket_arn,
          "${var.wal_archive_bucket_arn}/*"
        ]
      }
    ]
  })
}
