/**
 * E-GAOP TLS credential helpers for gRPC.
 *
 * Canonical implementation. Each service inlines the same pattern.
 * To update, edit this file and apply the same changes to every service's
 * getServerCredentials() / getClientCredentials() functions.
 *
 * NOTE: requestCert (mTLS) is disabled due to a bug in @grpc/grpc-js v1.14.4
 * where gRPC client connections fail when the server requests client certs.
 * Native TLS (without mTLS) works correctly — traffic is encrypted but
 * client certificates are not verified at the transport layer.
 *
 * Env vars:
 *   TLS_ENABLED=true           Enable TLS (default: false)
 *   TLS_CERT_DIR=/path         Certificate directory (default: /etc/egaop/certs)
 */

import * as grpc from "@grpc/grpc-js";
import fs from "fs";
import path from "path";

const CERT_DIR = process.env.TLS_CERT_DIR || "/etc/egaop/certs";
const TLS_ENABLED = process.env.TLS_ENABLED === "true";

function readCertBuffer(filename: string): Buffer {
  return fs.readFileSync(path.join(CERT_DIR, filename));
}

function readCertString(filename: string): string {
  return fs.readFileSync(path.join(CERT_DIR, filename), "utf8");
}

export function getServerCredentials(): grpc.ServerCredentials {
  if (!TLS_ENABLED) return grpc.ServerCredentials.createInsecure();
  const caCert = readCertBuffer("ca-cert.pem");
  const serverKey = readCertBuffer("server-key.pem");
  const serverCert = readCertBuffer("server-cert.pem");
  return grpc.ServerCredentials.createSsl(
    caCert,
    [{ cert_chain: serverCert, private_key: serverKey }],
    false  // don't request client cert (mTLS disabled, see note above)
  );
}

export function getClientCredentials(): grpc.ChannelCredentials {
  if (!TLS_ENABLED) return grpc.credentials.createInsecure();
  const caCert = readCertString("ca-cert.pem");
  const clientKey = readCertString("client-key.pem");
  const clientCert = readCertString("client-cert.pem");
  // grpc-js createSsl(rootCert, privateKey, certChain) — key before cert
  return grpc.credentials.createSsl(
    Buffer.from(caCert),
    Buffer.from(clientKey),
    Buffer.from(clientCert)
  );
}
