# E-GAOP Enterprise Agent Orchestration Platform
# Monorepo Makefile — 10 npm workspaces
# Usage: make help

.DEFAULT_GOAL := help

.PHONY: dev dev-docker dev-staging build clean \
	test test-api test-shared test-chaos test-load lint typecheck \
	docker-build docker-up docker-down docker-logs docker-ps docker-restart \
	db-shell db-backup db-restore db-status \
	monitoring grafana prometheus \
	secrets-init secrets-status secrets-rotate secrets-rotate-dry secrets-verify \
	tf-init tf-plan tf-apply tf-destroy tf-cost \
	health status help

# ─── Development ───────────────────────────────────────────────

dev:
	npm run dev

dev-docker:
	docker-compose up -d

dev-staging:
	docker-compose -f docker-compose.yml -f docker-compose.staging.yml up -d

build:
	npm run build

clean:
	rm -rf node_modules
	find . -type d -name node_modules -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name dist -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name coverage -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.tsbuildinfo" -delete 2>/dev/null || true
	find . -type f -name "*.tgz" -delete 2>/dev/null || true

# ─── Testing ──────────────────────────────────────────────────

test:
	npm run test

test-api:
	cd packages/api-server && npm test

test-shared:
	cd packages/shared && npm test

test-chaos:
	npx tsx tests/chaos/integration.test.ts

test-load:
	k6 run tests/load/scenarios/load-test.js

lint:
	npm run lint

typecheck:
	npm run typecheck

# ─── Docker ───────────────────────────────────────────────────

docker-build:
	docker-compose build

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down -v

docker-logs:
	docker-compose logs -f

docker-ps:
	docker-compose ps

docker-restart:
	docker-compose restart api-server

# ─── Database ─────────────────────────────────────────────────

db-shell:
	docker-compose exec postgres psql -U postgres -d egaop

db-backup:
	./scripts/backup.sh

db-restore:
ifndef BACKUP
	@echo "Usage: make db-restore BACKUP=path/to/backup.sql"
	@exit 1
endif
	./scripts/restore.sh $(BACKUP)

db-status:
	@docker-compose exec postgres pg_isready -U postgres -d egaop && echo "PostgreSQL is ready" || echo "PostgreSQL is not ready"

# ─── Monitoring ───────────────────────────────────────────────

monitoring:
	docker-compose -f docker-compose.yml -f docker-compose.secrets.yml up -d prometheus grafana tempo loki

grafana:
	@echo "Opening Grafana..."
	@start http://localhost:3000 2>/dev/null || open http://localhost:3000 2>/dev/null || echo "Open http://localhost:3000 in your browser"

prometheus:
	@echo "Opening Prometheus..."
	@start http://localhost:9090 2>/dev/null || open http://localhost:9090 2>/dev/null || echo "Open http://localhost:9090 in your browser"

# ─── Secrets ──────────────────────────────────────────────────

secrets-init:
	./scripts/init-secrets.sh

secrets-status:
	@echo "Checking secrets status..."
	@test -f .env && echo ".env exists" || echo ".env is MISSING"
	@test -f packages/api-server/.env && echo "api-server .env exists" || echo "api-server .env is MISSING"
	@test -f packages/web-dashboard/.env && echo "web-dashboard .env exists" || echo "web-dashboard .env is MISSING"

secrets-rotate:
	./scripts/rotate-secrets.sh

secrets-rotate-dry:
	./scripts/rotate-secrets.sh --dry-run

secrets-verify:
	./scripts/verify-secrets.sh

# ─── Infrastructure ───────────────────────────────────────────

tf-init: ## Initialize Terraform
	cd infrastructure/terraform && terraform init

tf-plan: ## Plan Terraform changes (staging)
	cd infrastructure/terraform && terraform workspace select staging && terraform plan -var-file=environments/staging.tfvars

tf-apply: ## Apply Terraform changes (staging)
	./scripts/tf-apply.sh staging

tf-destroy: ## Destroy Terraform infrastructure (requires confirmation)
	cd infrastructure/terraform && terraform destroy -var-file=environments/staging.tfvars

tf-cost: ## Run Infracost cost estimation
	cd infrastructure/terraform && infracost breakdown --usage-file infracost-usage.yml

# ─── Utilities ────────────────────────────────────────────────

health:
	@echo "Checking API Server..."
	@curl -sf http://localhost:3000/health || echo "API Server is not responding"
	@echo "Checking Web Dashboard..."
	@curl -sf http://localhost:5173/health || echo "Web Dashboard is not responding"
	@echo "Checking Orchestrator..."
	@curl -sf http://localhost:3001/health || echo "Orchestrator is not responding"

status:
	@echo "=== Service Status ==="
	@docker-compose ps
	@echo ""
	@echo "=== Health Checks ==="
	@make --no-print-directory health

help:
	@echo "E-GAOP — Available Make Targets"
	@echo ""
	@echo "Development:"
	@echo "  dev              Start all services locally (npm run dev)"
	@echo "  dev-docker       Start full stack via docker-compose"
	@echo "  dev-staging      Start staging environment"
	@echo "  build            Build all workspaces"
	@echo "  clean            Remove node_modules, dist, coverage, temp files"
	@echo ""
	@echo "Testing:"
	@echo "  test             Run all tests"
	@echo "  test-api         Run api-server tests only"
	@echo "  test-shared      Run shared package tests only"
	@echo "  test-chaos       Run chaos integration tests"
	@echo "  test-load        Run k6 load test"
	@echo "  lint             Run eslint across all workspaces"
	@echo "  typecheck        Run TypeScript type checking"
	@echo ""
	@echo "Docker:"
	@echo "  docker-build     Build all Docker images"
	@echo "  docker-up        docker-compose up -d"
	@echo "  docker-down      docker-compose down -v"
	@echo "  docker-logs      docker-compose logs -f"
	@echo "  docker-ps        Show running containers"
	@echo "  docker-restart   docker-compose restart api-server"
	@echo ""
	@echo "Database:"
	@echo "  db-shell         psql shell into PostgreSQL"
	@echo "  db-backup        Run scripts/backup.sh"
	@echo "  db-restore       Run scripts/restore.sh (usage: make db-restore BACKUP=path)"
	@echo "  db-status        Check PostgreSQL connection"
	@echo ""
	@echo "Monitoring:"
	@echo "  monitoring       Start Prometheus + Grafana + Tempo + Loki"
	@echo "  grafana          Open Grafana in browser"
	@echo "  prometheus       Open Prometheus in browser"
	@echo ""
	@echo "Secrets:"
	@echo "  secrets-init         Generate secrets for local dev"
	@echo "  secrets-status       Check if secrets files exist"
	@echo "  secrets-rotate       Rotate all secrets (interactive)"
	@echo "  secrets-rotate-dry   Preview secret rotation without executing"
	@echo "  secrets-verify       Verify all secrets are valid"
	@echo ""
	@echo "Infrastructure:"
	@echo "  tf-init          Initialize Terraform"
	@echo "  tf-plan          Plan Terraform changes (staging)"
	@echo "  tf-apply         Apply Terraform changes (staging)"
	@echo "  tf-destroy       Destroy Terraform infrastructure"
	@echo "  tf-cost          Run Infracost cost estimation"
	@echo ""
	@echo "Utilities:"
	@echo "  health           Curl all health endpoints"
	@echo "  status           Show service status + health"
	@echo "  help             List all targets with descriptions"
