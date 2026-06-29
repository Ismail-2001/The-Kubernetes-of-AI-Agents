#!/usr/bin/env bash
# =============================================================================
# E-GAOP mTLS Certificate Generator
# =============================================================================
# Generates a self-signed CA, server cert, and client cert for mTLS.
#
# Usage: bash certs/gen-certs.sh
#
# Prerequisites: openssl 1.1+ installed
# Output: certs/*.pem  (add these to .gitignore — NEVER commit private keys)
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OPENSSL_CNF="$DIR/openssl.cnf"

# --- CA ---
echo "=== Generating CA ==="
openssl genpkey -algorithm RSA -out "$DIR/ca-key.pem" -pkeyopt rsa_keygen_bits:4096
openssl req -x509 -new -nodes -key "$DIR/ca-key.pem" -sha256 -days 3650 \
  -out "$DIR/ca-cert.pem" \
  -subj "/CN=E-GAOP Development CA" \
  -extensions v3_ca -config "$OPENSSL_CNF"
echo "CA: ca-cert.pem + ca-key.pem"

# --- Server cert (wildcard *.egaop.internal + Docker service names) ---
echo "=== Generating Server Certificate ==="
openssl genpkey -algorithm RSA -out "$DIR/server-key.pem" -pkeyopt rsa_keygen_bits:2048
openssl req -new -key "$DIR/server-key.pem" -out "$DIR/server.csr" \
  -subj "/CN=*.egaop.internal" \
  -reqexts v3_req -config "$OPENSSL_CNF"
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca-cert.pem" -CAkey "$DIR/ca-key.pem" \
  -CAcreateserial -out "$DIR/server-cert.pem" -days 1825 -sha256 \
  -extfile "$OPENSSL_CNF" -extensions v3_req
rm -f "$DIR/server.csr" "$DIR/ca-cert.srl"
echo "Server: server-cert.pem + server-key.pem"

# --- Client cert ---
echo "=== Generating Client Certificate ==="
openssl genpkey -algorithm RSA -out "$DIR/client-key.pem" -pkeyopt rsa_keygen_bits:2048
openssl req -new -key "$DIR/client-key.pem" -out "$DIR/client.csr" \
  -subj "/CN=egaop-client" \
  -reqexts v3_req -config "$OPENSSL_CNF"
openssl x509 -req -in "$DIR/client.csr" -CA "$DIR/ca-cert.pem" -CAkey "$DIR/ca-key.pem" \
  -CAcreateserial -out "$DIR/client-cert.pem" -days 1825 -sha256 \
  -extfile "$OPENSSL_CNF" -extensions v3_req
rm -f "$DIR/client.csr" "$DIR/ca-cert.srl"
echo "Client: client-cert.pem + client-key.pem"

echo ""
echo "=== Done ==="
echo "To enable mTLS, set TLS_ENABLED=true and mount certs/ to /etc/egaop/certs/"
echo "In dev without Docker: TLS_CERT_DIR=$(pwd)/certs"
