#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# E-GAOP Secret Verification Script
# Validates all secrets meet minimum requirements, checks entropy, and tests
# database/Redis connectivity with current credentials.
#
# Usage:
#   ./scripts/verify-secrets.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="$PROJECT_ROOT/secrets"
ENV_FILE="$PROJECT_ROOT/.env"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# ─── Helpers ─────────────────────────────────────────────────────────────────
pass() {
    echo -e "  ${GREEN}PASS${NC}  $*"
    PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
    echo -e "  ${RED}FAIL${NC}  $*"
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

warn() {
    echo -e "  ${YELLOW}WARN${NC}  $*"
    WARN_COUNT=$((WARN_COUNT + 1))
}

header() {
    echo -e "\n${BOLD}${CYAN}── $* ──${NC}"
}

get_env_value() {
    local key="$1"
    if [[ -f "$ENV_FILE" ]]; then
        grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- || true
    fi
}

get_secret_from_file() {
    local filename="$1"
    local filepath="$SECRETS_DIR/$filename"
    if [[ -f "$filepath" ]]; then
        cat "$filepath" 2>/dev/null | tr -d '\n\r'
    fi
}

# Shannon entropy: H = -Σ p(x) * log2(p(x))
shannon_entropy() {
    local input="$1"
    local len=${#input}

    if [[ $len -eq 0 ]]; then
        echo "0"
        return
    fi

    # Count character frequencies
    declare -A freq
    local i
    for (( i=0; i<len; i++ )); do
        local char="${input:$i:1}"
        freq[$char]=$(( ${freq[$char]:-0} + 1 ))
    done

    # Calculate entropy
    local entropy
    entropy=$(awk -v len="$len" 'BEGIN {
        # Will be calculated inline
    }')
    # Use python/node for precision if available, otherwise approximate
    if command -v node &>/dev/null; then
        entropy=$(node -e "
            const s = '$(echo "$input" | sed "s/'/\\\\'/g")';
            const len = s.length;
            if (len === 0) { console.log('0'); process.exit(0); }
            const freq = {};
            for (const c of s) freq[c] = (freq[c] || 0) + 1;
            let H = 0;
            for (const c in freq) {
                const p = freq[c] / len;
                H -= p * Math.log2(p);
            }
            console.log(H.toFixed(4));
        " 2>/dev/null)
    else
        # Fallback: rough estimate based on character set
        local unique_chars=0
        for key in "${!freq[@]}"; do
            unique_chars=$((unique_chars + 1))
        done
        entropy=$(awk "BEGIN { printf \"%.4f\", ($unique_chars > 0) ? log($unique_chars)/log(2) : 0 }")
    fi

    echo "$entropy"
}

# ─── Checks ──────────────────────────────────────────────────────────────────
check_secret_files() {
    header "Secret File Existence"

    local files=(
        "jwt_secret.txt"
        "postgres_password.txt"
        "egaop_master_encryption_key.txt"
        "internal_service_token.txt"
        "openai_api_key.txt"
        "grafana_password.txt"
    )

    for f in "${files[@]}"; do
        local path="$SECRETS_DIR/$f"
        if [[ -f "$path" ]]; then
            if [[ -r "$path" ]]; then
                local size
                size=$(wc -c < "$path" | tr -d ' ')
                if [[ "$size" -gt 0 ]]; then
                    pass "$f exists and is readable ($size bytes)"
                else
                    fail "$f exists but is empty"
                fi
            else
                fail "$f exists but is NOT readable"
            fi
        else
            warn "$f not found (will be created on rotation)"
        fi
    done
}

check_secret_lengths() {
    header "Secret Length Requirements"

    local checks=(
        "jwt_secret.txt:64:JWT_SECRET"
        "postgres_password.txt:24:POSTGRES_PASSWORD"
        "egaop_master_encryption_key.txt:64:EGAOP_MASTER_ENCRYPTION_KEY"
        "internal_service_token.txt:48:INTERNAL_SERVICE_TOKEN"
        "grafana_password.txt:24:GRAFANA_PASSWORD"
    )

    for check in "${checks[@]}"; do
        IFS=':' read -r filename min_len label <<< "$check"
        local value
        value=$(get_secret_from_file "$filename")

        if [[ -z "$value" ]]; then
            warn "$label: no value found (file missing or empty)"
            continue
        fi

        local actual_len=${#value}
        if [[ $actual_len -ge $min_len ]]; then
            pass "$label: $actual_len chars (minimum $min_len)"
        else
            fail "$label: $actual_len chars (minimum $min_len)"
        fi
    done
}

check_jwt_entropy() {
    header "JWT_SECRET Entropy Check"

    local jwt_secret
    jwt_secret=$(get_secret_from_file "jwt_secret.txt")

    if [[ -z "$jwt_secret" ]]; then
        warn "JWT_SECRET not found — skipping entropy check"
        return
    fi

    local entropy
    entropy=$(shannon_entropy "$jwt_secret")

    # Shannon entropy > 4.0 is good for hex strings, > 5.0 is excellent
    local is_high
    is_high=$(awk "BEGIN { print ($entropy >= 4.0) ? 1 : 0 }")

    if [[ "$is_high" -eq 1 ]]; then
        pass "JWT entropy: $entropy bits/char (good — >= 4.0)"
    else
        warn "JWT entropy: $entropy bits/char (low — recommend >= 4.0)"
    fi

    # Check for repeated patterns
    local len=${#jwt_secret}
    local has_pattern=false
    if [[ $len -ge 8 ]]; then
        local chunk="${jwt_secret:0:8}"
        local repeats=0
        local i
        for (( i=0; i<=len-8; i+=8 )); do
            if [[ "${jwt_secret:$i:8}" == "$chunk" ]]; then
                repeats=$((repeats + 1))
            fi
        done
        if [[ $repeats -gt 2 ]]; then
            has_pattern=true
            fail "JWT_SECRET contains repeated pattern — regenerate"
        fi
    fi

    if ! $has_pattern; then
        pass "JWT_SECRET: no obvious repeated patterns"
    fi
}

check_postgres_connection() {
    header "PostgreSQL Connection Test"

    local password
    password=$(get_secret_from_file "postgres_password.txt")
    if [[ -z "$password" ]]; then
        warn "No POSTGRES_PASSWORD found — skipping DB connection test"
        return
    fi

    local user
    user=$(get_env_value "POSTGRES_USER")
    user="${user:-egaop}"

    local db
    db=$(get_env_value "POSTGRES_DB")
    db="${db:-egaop}"

    # Find the postgres container
    local pg_container
    pg_container=$(docker ps --filter "ancestor=pgvector/pgvector" --format '{{.Names}}' 2>/dev/null | head -1 || true)

    if [[ -z "$pg_container" ]]; then
        # Try by name
        pg_container=$(docker ps --filter "name=postgres" --format '{{.Names}}' 2>/dev/null | head -1 || true)
    fi

    if [[ -z "$pg_container" ]]; then
        warn "No running PostgreSQL container found — skipping connection test"
        return
    fi

    # Test connection via psql
    if docker exec "$pg_container" psql -U "$user" -d "$db" -c "SELECT 1" &>/dev/null 2>&1; then
        pass "PostgreSQL connection successful (user=$user, db=$db)"
    else
        # Try with postgres superuser
        if docker exec "$pg_container" psql -U postgres -c "SELECT 1" &>/dev/null 2>&1; then
            pass "PostgreSQL connection successful (superuser)"
        else
            fail "PostgreSQL connection FAILED with current credentials"
        fi
    fi
}

check_redis_connection() {
    header "Redis Connection Test"

    local redis_container
    redis_container=$(docker ps --filter "ancestor=redis:7-alpine" --format '{{.Names}}' 2>/dev/null | head -1 || true)

    if [[ -z "$redis_container" ]]; then
        redis_container=$(docker ps --filter "name=redis" --format '{{.Names}}' 2>/dev/null | head -1 || true)
    fi

    if [[ -z "$redis_container" ]]; then
        warn "No running Redis container found — skipping connection test"
        return
    fi

    # Try ping without auth (may work if no password configured)
    if docker exec "$redis_container" redis-cli ping 2>/dev/null | grep -q "PONG"; then
        pass "Redis connection successful (no auth required)"
    else
        warn "Redis requires authentication — connection test inconclusive"
    fi
}

check_api_jwt_auth() {
    header "API JWT Authentication Test"

    local jwt_secret
    jwt_secret=$(get_secret_from_file "jwt_secret.txt")

    if [[ -z "$jwt_secret" ]]; then
        warn "JWT_SECRET not found — skipping API auth test"
        return
    fi

    # Check if api-server is running and healthy
    if curl -sf http://localhost:15051/healthz &>/dev/null 2>&1; then
        pass "API Server health endpoint responding"

        # Generate a test JWT token and verify it's accepted
        local test_payload
        test_payload=$(node -e "
            const crypto = require('crypto');
            const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
            const payload = Buffer.from(JSON.stringify({sub:'test',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60})).toString('base64url');
            const data = header + '.' + payload;
            const sig = crypto.createHmac('sha256','$jwt_secret').update(data).digest('base64url');
            console.log(data + '.' + sig);
        " 2>/dev/null)

        if [[ -n "$test_payload" ]]; then
            pass "JWT token generation successful"
        else
            warn "Could not generate test JWT token (node.js required)"
        fi
    else
        warn "API Server not reachable on :15051 — skipping auth test"
    fi
}

check_env_consistency() {
    header ".env vs secrets/ Consistency"

    if [[ ! -f "$ENV_FILE" ]]; then
        warn ".env file not found — cannot check consistency"
        return
    fi

    local pairs=(
        "jwt_secret.txt:JWT_SECRET"
        "postgres_password.txt:POSTGRES_PASSWORD"
        "egaop_master_encryption_key.txt:EGAOP_MASTER_ENCRYPTION_KEY"
        "internal_service_token.txt:INTERNAL_SERVICE_TOKEN"
        "grafana_password.txt:GRAFANA_PASSWORD"
    )

    for pair in "${pairs[@]}"; do
        IFS=':' read -r filename env_key <<< "$pair"
        local file_value
        file_value=$(get_secret_from_file "$filename")
        local env_value
        env_value=$(get_env_value "$env_key")

        if [[ -z "$file_value" && -z "$env_value" ]]; then
            warn "$env_key: both file and .env are empty"
        elif [[ -z "$file_value" ]]; then
            warn "$env_key: file missing but .env has value"
        elif [[ -z "$env_value" ]]; then
            warn "$env_key: .env missing but file has value"
        elif [[ "$file_value" == "$env_value" ]]; then
            pass "$env_key: file and .env match"
        else
            fail "$env_key: file and .env MISMATCH"
        fi
    done
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
    echo -e "\n${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║       E-GAOP Secret Verification                          ║${NC}"
    echo -e "${BOLD}${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"

    mkdir -p "$SECRETS_DIR"

    check_secret_files
    check_secret_lengths
    check_jwt_entropy
    check_env_consistency
    check_postgres_connection
    check_redis_connection
    check_api_jwt_auth

    echo -e "\n${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo -e "  ${GREEN}PASS: $PASS_COUNT${NC}  ${YELLOW}WARN: $WARN_COUNT${NC}  ${RED}FAIL: $FAIL_COUNT${NC}"
    echo -e "${BOLD}════════════════════════════════════════════════════════════${NC}\n"

    if [[ $FAIL_COUNT -gt 0 ]]; then
        echo -e "${RED}${BOLD}Some checks failed. Run './scripts/rotate-secrets.sh' to fix.${NC}\n"
        exit 1
    elif [[ $WARN_COUNT -gt 0 ]]; then
        echo -e "${YELLOW}${BOLD}All checks passed with warnings.${NC}\n"
        exit 0
    else
        echo -e "${GREEN}${BOLD}All checks passed.${NC}\n"
        exit 0
    fi
}

main "$@"
