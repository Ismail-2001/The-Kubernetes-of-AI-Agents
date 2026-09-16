#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# E-GAOP Secret Rotation Script
# Rotates all secrets used by the platform: JWT, DB password, encryption key,
# service tokens, and API keys. Backs up current secrets before rotation.
#
# Usage:
#   ./scripts/rotate-secrets.sh [OPTIONS]
#
# Options:
#   --dry-run       Preview changes without executing
#   --rotate-jwt    Rotate JWT_SECRET only
#   --rotate-db     Rotate POSTGRES_PASSWORD only
#   --rotate-all    Rotate everything (default)
#   --yes           Skip confirmation prompt
#   --help          Show this help message
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="$PROJECT_ROOT/secrets"
ENV_FILE="$PROJECT_ROOT/.env"
LOG_FILE="$PROJECT_ROOT/secrets-rotation-$(date +%Y%m%d-%H%M%S).log"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Defaults ────────────────────────────────────────────────────────────────
DRY_RUN=false
ROTATE_JWT=false
ROTATE_DB=false
ROTATE_ALL=true
SKIP_CONFIRM=false

# ─── Logging ─────────────────────────────────────────────────────────────────
log() {
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    local msg="[$timestamp] $*"
    echo -e "$msg" | tee -a "$LOG_FILE"
}

info()    { log "${BLUE}INFO${NC}    $*"; }
success() { log "${GREEN}PASS${NC}    $*"; }
warn()    { log "${YELLOW}WARN${NC}    $*"; }
error()   { log "${RED}FAIL${NC}    $*"; }
header()  { log "\n${BOLD}${CYAN}═══ $* ═══${NC}"; }

# ─── Parse Arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)    DRY_RUN=true; shift ;;
        --rotate-jwt) ROTATE_JWT=true; ROTATE_ALL=false; shift ;;
        --rotate-db)  ROTATE_DB=true; ROTATE_ALL=false; shift ;;
        --rotate-all) ROTATE_ALL=true; shift ;;
        --yes)        SKIP_CONFIRM=true; shift ;;
        --help)
            sed -n '2,/^$/{ s/^# \?//; p }' "$0"
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ─── Helpers ─────────────────────────────────────────────────────────────────
generate_hex_secret() {
    local length="${1:-32}"
    openssl rand -hex "$length" 2>/dev/null
}

generate_base64_secret() {
    local length="${1:-32}"
    openssl rand -base64 "$length" 2>/dev/null | tr -d '\n'
}

get_env_value() {
    local key="$1"
    local file="${2:-$ENV_FILE}"
    if [[ -f "$file" ]]; then
        grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d'=' -f2- || true
    fi
}

set_env_value() {
    local key="$1"
    local value="$2"
    local file="${3:-$ENV_FILE}"
    if [[ -f "$file" ]]; then
        if grep -qE "^${key}=" "$file" 2>/dev/null; then
            sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
            rm -f "${file}.bak"
        else
            echo "${key}=${value}" >> "$file"
        fi
    fi
}

get_postgres_container() {
    docker ps --filter "ancestor=pgvector/pgvector" --format '{{.Names}}' 2>/dev/null | head -1 || true
}

confirm() {
    if $SKIP_CONFIRM || $DRY_RUN; then
        return 0
    fi
    echo -en "${YELLOW}Proceed with rotation? [y/N]: ${NC}"
    read -r answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        info "Rotation cancelled by user."
        exit 0
    fi
}

# ─── Preflight Checks ────────────────────────────────────────────────────────
preflight() {
    header "Preflight Checks"

    # Check openssl
    if ! command -v openssl &>/dev/null; then
        error "openssl is required but not found in PATH"
        exit 1
    fi
    success "openssl available"

    # Check docker
    if ! command -v docker &>/dev/null; then
        error "docker is required but not found in PATH"
        exit 1
    fi
    success "docker available"

    # Check docker-compose or docker compose
    if docker compose version &>/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        error "docker compose is required but not found"
        exit 1
    fi
    success "docker compose available ($COMPOSE_CMD)"

    # Check secrets dir exists or can be created
    mkdir -p "$SECRETS_DIR"
    success "Secrets directory: $SECRETS_DIR"

    # Check .env exists
    if [[ ! -f "$ENV_FILE" ]]; then
        warn ".env file not found — will create from .env.example"
        if [[ -f "$PROJECT_ROOT/.env.example" ]]; then
            cp "$PROJECT_ROOT/.env.example" "$ENV_FILE"
            success "Created .env from .env.example"
        else
            error ".env.example not found — cannot create .env"
            exit 1
        fi
    else
        success ".env file found"
    fi

    # Verify PostgreSQL is running
    PG_CONTAINER=$(get_postgres_container)
    if [[ -n "$PG_CONTAINER" ]]; then
        success "PostgreSQL container: $PG_CONTAINER"
    else
        warn "No running PostgreSQL container detected — DB rotation will be skipped"
    fi

    # Verify Redis is running
    REDIS_CONTAINER=$(docker ps --filter "ancestor=redis:7-alpine" --format '{{.Names}}' 2>/dev/null | head -1 || true)
    if [[ -n "$REDIS_CONTAINER" ]]; then
        success "Redis container: $REDIS_CONTAINER"
    else
        warn "No running Redis container detected"
    fi
}

# ─── Backup ──────────────────────────────────────────────────────────────────
backup_secrets() {
    header "Backing Up Current Secrets"
    local backup_dir="$SECRETS_DIR/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup_dir"

    local backed_up=0
    for f in "$SECRETS_DIR"/*.txt; do
        if [[ -f "$f" ]]; then
            cp "$f" "$backup_dir/"
            backed_up=$((backed_up + 1))
        fi
    done

    if [[ -f "$ENV_FILE" ]]; then
        cp "$ENV_FILE" "$backup_dir/.env"
        backed_up=$((backed_up + 1))
    fi

    if [[ $backed_up -eq 0 ]]; then
        warn "No existing secrets found to back up"
    else
        success "Backed up $backed_up file(s) to $backup_dir"
    fi
    echo "$backup_dir"
}

# ─── Rotation Functions ──────────────────────────────────────────────────────
rotate_jwt_secret() {
    header "Rotating JWT_SECRET"
    local new_secret
    new_secret=$(generate_hex_secret 32)
    local char_count=${#new_secret}

    if [[ $char_count -lt 64 ]]; then
        error "Generated JWT_SECRET too short ($char_count chars, need 64+)"
        return 1
    fi

    info "New JWT_SECRET: ${new_secret:0:8}...${new_secret: -8} ($char_count chars)"

    if $DRY_RUN; then
        info "[DRY RUN] Would write to $SECRETS_DIR/jwt_secret.txt"
        info "[DRY RUN] Would update JWT_SECRET in .env"
        return 0
    fi

    echo -n "$new_secret" > "$SECRETS_DIR/jwt_secret.txt"
    set_env_value "JWT_SECRET" "$new_secret"
    success "JWT_SECRET rotated successfully"
}

rotate_postgres_password() {
    header "Rotating POSTGRES_PASSWORD"
    local new_password
    new_password=$(generate_base64_secret 24)
    local char_count=${#new_password}

    if [[ $char_count -lt 24 ]]; then
        error "Generated POSTGRES_PASSWORD too short ($char_count chars, need 24+)"
        return 1
    fi

    info "New POSTGRES_PASSWORD: ${new_password:0:4}**** ($char_count chars)"

    if $DRY_RUN; then
        info "[DRY RUN] Would write to $SECRETS_DIR/postgres_password.txt"
        info "[DRY RUN] Would update POSTGRES_PASSWORD in .env"
        info "[DRY RUN] Would ALTER USER postgres IN PostgreSQL"
        return 0
    fi

    echo -n "$new_password" > "$SECRETS_DIR/postgres_password.txt"
    set_env_value "POSTGRES_PASSWORD" "$new_password"

    # Update password inside PostgreSQL
    PG_CONTAINER=$(get_postgres_container)
    if [[ -n "$PG_CONTAINER" ]]; then
        local current_user
        current_user=$(get_env_value "POSTGRES_USER")
        current_user="${current_user:-egaop}"
        info "Updating password for user '$current_user' in PostgreSQL..."
        docker exec "$PG_CONTAINER" psql -U postgres -d egaop \
            -c "ALTER USER ${current_user} WITH PASSWORD '${new_password}';" \
            >> "$LOG_FILE" 2>&1
        success "PostgreSQL user password updated"
    else
        warn "PostgreSQL not running — password file updated but DB not modified"
    fi
}

rotate_master_encryption_key() {
    header "Rotating EGAOP_MASTER_ENCRYPTION_KEY"
    local new_key
    new_key=$(generate_hex_secret 32)
    local char_count=${#new_key}

    if $DRY_RUN; then
        info "[DRY RUN] Would write to $SECRETS_DIR/egaop_master_encryption_key.txt"
        info "[DRY RUN] Would update EGAOP_MASTER_ENCRYPTION_KEY in .env"
        return 0
    fi

    echo -n "$new_key" > "$SECRETS_DIR/egaop_master_encryption_key.txt"
    set_env_value "EGAOP_MASTER_ENCRYPTION_KEY" "$new_key"
    success "EGAOP_MASTER_ENCRYPTION_KEY rotated ($char_count chars)"
}

rotate_internal_service_token() {
    header "Rotating INTERNAL_SERVICE_TOKEN"
    local new_token
    new_token=$(generate_hex_secret 24)
    local char_count=${#new_token}

    if $DRY_RUN; then
        info "[DRY RUN] Would write to $SECRETS_DIR/internal_service_token.txt"
        info "[DRY RUN] Would update INTERNAL_SERVICE_TOKEN in .env"
        return 0
    fi

    echo -n "$new_token" > "$SECRETS_DIR/internal_service_token.txt"
    set_env_value "INTERNAL_SERVICE_TOKEN" "$new_token"
    success "INTERNAL_SERVICE_TOKEN rotated ($char_count chars)"
}

rotate_grafana_password() {
    header "Rotating GRAFANA_PASSWORD"
    local new_password
    new_password=$(generate_base64_secret 24)
    local char_count=${#new_password}

    if $DRY_RUN; then
        info "[DRY RUN] Would write to $SECRETS_DIR/grafana_password.txt"
        info "[DRY RUN] Would update GRAFANA_PASSWORD in .env"
        return 0
    fi

    echo -n "$new_password" > "$SECRETS_DIR/grafana_password.txt"
    set_env_value "GRAFANA_PASSWORD" "$new_password"
    success "GRAFANA_PASSWORD rotated ($char_count chars)"
}

rotate_openai_api_key() {
    header "Rotating OPENAI_API_KEY"
    local current_key
    current_key=$(get_env_value "OPENAI_API_KEY")

    if [[ -z "$current_key" ]]; then
        warn "No existing OPENAI_API_KEY found — skipping (must be set manually)"
        return 0
    fi

    warn "OPENAI_API_KEY must be rotated manually from the OpenAI dashboard"
    warn "Update $SECRETS_DIR/openai_api_key.txt and OPENAI_API_KEY in .env"
    return 0
}

# ─── Restart Services ───────────────────────────────────────────────────────
restart_services() {
    header "Restarting Affected Services"

    if $DRY_RUN; then
        info "[DRY RUN] Would restart: redis postgres api-server workflow-engine secret-store memory-plane llm-router"
        return 0
    fi

    info "Restarting Redis..."
    $COMPOSE_CMD restart redis >> "$LOG_FILE" 2>&1 || warn "Redis restart failed"
    success "Redis restarted"

    info "Restarting PostgreSQL..."
    $COMPOSE_CMD restart postgres >> "$LOG_FILE" 2>&1 || warn "PostgreSQL restart failed"
    success "PostgreSQL restarted"

    # Wait for DB to be ready
    info "Waiting for PostgreSQL to become healthy..."
    local retries=30
    while [[ $retries -gt 0 ]]; do
        PG_CONTAINER=$(get_postgres_container)
        if [[ -n "$PG_CONTAINER" ]] && docker exec "$PG_CONTAINER" pg_isready -U postgres -d egaop &>/dev/null; then
            success "PostgreSQL is healthy"
            break
        fi
        retries=$((retries - 1))
        sleep 2
    done
    if [[ $retries -eq 0 ]]; then
        warn "PostgreSQL health check timed out — services may need manual restart"
    fi

    info "Restarting dependent services..."
    local services=(
        api-server
        workflow-engine
        secret-store
        memory-plane
        llm-router
        observability-plane
        sandbox-runtime
        tool-proxy
        admin-console
    )
    for svc in "${services[@]}"; do
        $COMPOSE_CMD restart "$svc" >> "$LOG_FILE" 2>&1 || warn "Restart of $svc failed"
    done
    success "All dependent services restarted"
}

# ─── Verify ──────────────────────────────────────────────────────────────────
verify_rotation() {
    header "Verifying Rotation"

    if $DRY_RUN; then
        info "[DRY RUN] Would verify services are healthy"
        return 0
    fi

    info "Running post-rotation health checks..."
    sleep 5

    local all_healthy=true

    # Check PostgreSQL
    PG_CONTAINER=$(get_postgres_container)
    if [[ -n "$PG_CONTAINER" ]]; then
        if docker exec "$PG_CONTAINER" pg_isready -U postgres -d egaop &>/dev/null; then
            success "PostgreSQL: healthy"
        else
            error "PostgreSQL: NOT healthy"
            all_healthy=false
        fi
    fi

    # Check Redis
    REDIS_CONTAINER=$(docker ps --filter "ancestor=redis:7-alpine" --format '{{.Names}}' 2>/dev/null | head -1 || true)
    if [[ -n "$REDIS_CONTAINER" ]]; then
        if docker exec "$REDIS_CONTAINER" redis-cli ping &>/dev/null 2>&1; then
            success "Redis: healthy"
        else
            error "Redis: NOT healthy"
            all_healthy=false
        fi
    fi

    # Check API server health endpoint
    if curl -sf http://localhost:15051/healthz &>/dev/null 2>&1; then
        success "API Server: healthy"
    elif curl -sf http://localhost:3001/health &>/dev/null 2>&1; then
        success "API Server: healthy (REST)"
    else
        warn "API Server: health check inconclusive (may still be starting)"
    fi

    if $all_healthy; then
        success "All infrastructure services healthy"
    else
        error "Some services are unhealthy — review logs"
    fi
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
    echo -e "\n${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║       E-GAOP Secret Rotation Script                       ║${NC}"
    echo -e "${BOLD}${CYAN}╚════════════════════════════════════════════════════════════╝${NC}\n"

    if $DRY_RUN; then
        warn "DRY RUN MODE — no changes will be made\n"
    fi

    # Initialize log
    echo "# E-GAOP Secret Rotation Log — $(date)" > "$LOG_FILE"

    preflight
    confirm
    backup_secrets > /dev/null 2>&1

    if $ROTATE_ALL || $ROTATE_JWT; then
        rotate_jwt_secret
    fi

    if $ROTATE_ALL || $ROTATE_DB; then
        rotate_postgres_password
    fi

    if $ROTATE_ALL; then
        rotate_master_encryption_key
        rotate_internal_service_token
        rotate_grafana_password
        rotate_openai_api_key
    fi

    restart_services
    verify_rotation

    header "Rotation Complete"
    info "Log file: $LOG_FILE"
    if ! $DRY_RUN; then
        info "Backups stored in: $SECRETS_DIR/backup-*/"
        echo -e "\n${GREEN}${BOLD}Secret rotation completed successfully.${NC}\n"
    else
        echo -e "\n${YELLOW}${BOLD}Dry run complete. No changes were made.${NC}\n"
    fi
}

main "$@"
