resource "aws_s3_bucket" "wal_archive" {
  bucket = "${var.name_prefix}-wal-archive"

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-wal-archive"
  })
}

resource "aws_s3_bucket_versioning" "wal_archive" {
  bucket = aws_s3_bucket.wal_archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "wal_archive" {
  bucket = aws_s3_bucket.wal_archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "wal_archive" {
  bucket = aws_s3_bucket.wal_archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "wal_archive" {
  bucket = aws_s3_bucket.wal_archive.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = 365
    }
  }
}

resource "aws_s3_bucket_policy" "wal_archive" {
  bucket = aws_s3_bucket.wal_archive.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowRDSWALUpload"
        Effect = "Allow"
        Principal = {
          AWS = var.rds_role_arn
        }
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
          "s3:ListBucketMultipartUploads"
        ]
        Resource = [
          aws_s3_bucket.wal_archive.arn,
          "${aws_s3_bucket.wal_archive.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_s3_bucket" "backup" {
  bucket = "${var.name_prefix}-backups"

  tags = merge(var.common_tags, {
    Name = "${var.name_prefix}-backups"
  })
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket = aws_s3_bucket.backup.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 730
    }
  }
}
