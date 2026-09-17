output "wal_archive_bucket_name" {
  description = "WAL archive bucket name"
  value       = aws_s3_bucket.wal_archive.id
}

output "wal_archive_bucket_arn" {
  description = "WAL archive bucket ARN"
  value       = aws_s3_bucket.wal_archive.arn
}

output "backup_bucket_name" {
  description = "Backup bucket name"
  value       = aws_s3_bucket.backup.id
}

output "backup_bucket_arn" {
  description = "Backup bucket ARN"
  value       = aws_s3_bucket.backup.arn
}
