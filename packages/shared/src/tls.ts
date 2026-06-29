/**
 * E-GAOP TLS credential helpers for gRPC.
 *
 * Canonical implementation. Each service inlines the same pattern.
 * To update, edit this file and apply the same changes to every service's
 * getServerCredentials() / getClientCredentials() functions.
 *
 * Env vars:
 *   TLS_ENABLED=true           Enable mTLS (default: false)
 *   TLS_CERT_DIR=/path         Certificate directory (default: /etc/egaop/certs)
 */

import * as grpc from "@grpc/grpc-js";
import fs from "fs";
import path from "path";

const CERT_DIR = process.env.TLS_CERT_DIR || "/etc/egaop/certs";
const TLS_ENABLED = process.env.TLS_ENABLED === "true";

function readCert(filename: string): Buffer {
  return fs.readFileSync(path.join(CERT_DIR, filename));
}

export function getServerCredentials(): grpc.ServerCredentials {
  if (!TLS_ENABLED) return grpc.ServerCredentials.createInsecure();
  const caCert = readCert("ca-cert.pem");
  const serverKey = readCert("server-key.pem");
  const serverCert = readCert("server-cert.pem");
  return grpc.ServerCredentials.createSsl(
    caCert,
    [{ cert_chain: serverCert, private_key: serverKey }],
    true  // require client cert (mutual TLS)
  );
}

export function getClientCredentials(): grpc.ChannelCredentials {
  if (!TLS_ENABLED) return grpc.credentials.createInsecure();
  const caCert = readCert("ca-cert.pem");
  const clientKey = readCert("client-key.pem");
  const clientCert = readCert("client-cert.pem");
  return grpc.credentials.createSsl(caCert, clientCert, clientKey);
}
