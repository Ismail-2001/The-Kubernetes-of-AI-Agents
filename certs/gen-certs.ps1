# =============================================================================
# E-GAOP mTLS Certificate Generator (PowerShell)
# =============================================================================
# Generates a self-signed CA, server cert, and client cert for mTLS.
#
# Usage: .\certs\gen-certs.ps1
#
# Prerequisites: openssl 1.1+ in PATH (available via Git Bash, WSL, or Chocolatey)
# Output: certs\*.pem  (add these to .gitignore — NEVER commit private keys)
# =============================================================================
$ErrorActionPreference = "Stop"
$DIR = Split-Path -Parent $PSCommandPath
$OPENSSL_CNF = Join-Path $DIR "openssl.cnf"

function Run-OpenSSL {
    param([string]$Args)
    $p = Start-Process -NoNewWindow -Wait -PassThru -FilePath "openssl" -ArgumentList $Args
    if ($p.ExitCode -ne 0) { throw "openssl failed with exit code $($p.ExitCode)" }
}

Write-Host "=== Generating CA ===" -ForegroundColor Green
Run-OpenSSL "genpkey -algorithm RSA -out `"$DIR/ca-key.pem`" -pkeyopt rsa_keygen_bits:4096"
Run-OpenSSL "req -x509 -new -nodes -key `"$DIR/ca-key.pem`" -sha256 -days 3650 -out `"$DIR/ca-cert.pem`" -subj '/CN=E-GAOP Development CA' -extensions v3_ca -config `"$OPENSSL_CNF`""
Write-Host "CA: ca-cert.pem + ca-key.pem" -ForegroundColor Green

Write-Host "=== Generating Server Certificate ===" -ForegroundColor Green
Run-OpenSSL "genpkey -algorithm RSA -out `"$DIR/server-key.pem`" -pkeyopt rsa_keygen_bits:2048"
Run-OpenSSL "req -new -key `"$DIR/server-key.pem`" -out `"$DIR/server.csr`" -subj '/CN=*.egaop.internal' -reqexts v3_req -config `"$OPENSSL_CNF`""
Run-OpenSSL "x509 -req -in `"$DIR/server.csr`" -CA `"$DIR/ca-cert.pem`" -CAkey `"$DIR/ca-key.pem`" -CAcreateserial -out `"$DIR/server-cert.pem`" -days 1825 -sha256 -extfile `"$OPENSSL_CNF`" -extensions v3_req"
Remove-Item -Force "$DIR/server.csr", "$DIR/ca-cert.srl" -ErrorAction SilentlyContinue
Write-Host "Server: server-cert.pem + server-key.pem" -ForegroundColor Green

Write-Host "=== Generating Client Certificate ===" -ForegroundColor Green
Run-OpenSSL "genpkey -algorithm RSA -out `"$DIR/client-key.pem`" -pkeyopt rsa_keygen_bits:2048"
Run-OpenSSL "req -new -key `"$DIR/client-key.pem`" -out `"$DIR/client.csr`" -subj '/CN=egaop-client' -reqexts v3_req -config `"$OPENSSL_CNF`""
Run-OpenSSL "x509 -req -in `"$DIR/client.csr`" -CA `"$DIR/ca-cert.pem`" -CAkey `"$DIR/ca-key.pem`" -CAcreateserial -out `"$DIR/client-cert.pem`" -days 1825 -sha256 -extfile `"$OPENSSL_CNF`" -extensions v3_req"
Remove-Item -Force "$DIR/client.csr", "$DIR/ca-cert.srl" -ErrorAction SilentlyContinue
Write-Host "Client: client-cert.pem + client-key.pem" -ForegroundColor Green

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "To enable mTLS, set TLS_ENABLED=true and mount certs/ to /etc/egaop/certs/"
