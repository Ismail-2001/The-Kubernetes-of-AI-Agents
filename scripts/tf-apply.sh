#!/usr/bin/env bash
# Apply Terraform changes for a specific environment
# Usage: ./scripts/tf-apply.sh <environment> [--plan-only]

set -euo pipefail

ENV="${1:?Usage: $0 <dev|staging|production> [--plan-only]}"
PLAN_ONLY="${2:-}"

if [[ ! "$ENV" =~ ^(dev|staging|production)$ ]]; then
  echo "❌ Invalid environment: $ENV (must be dev, staging, or production)"
  exit 1
fi

cd infrastructure/terraform

echo "🔧 Initializing Terraform..."
terraform init

echo "📂 Selecting workspace: $ENV"
terraform workspace select "$ENV" || terraform workspace new "$ENV"

echo "📋 Planning changes for $ENV..."
terraform plan -var-file="environments/${ENV}.tfvars" -out=tfplan

if [ "$PLAN_ONLY" = "--plan-only" ]; then
  echo "✅ Plan complete (not applying). Review tfplan file."
  exit 0
fi

echo "🚀 Applying changes for $ENV..."
read -p "Apply changes to $ENV? (yes/no): " CONFIRM
if [ "$CONFIRM" = "yes" ]; then
  terraform apply tfplan
  echo "✅ Applied successfully to $ENV"
else
  echo "❌ Aborted."
  exit 1
fi
