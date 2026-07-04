const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const tls = require("tls");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CERT_DIR = "/etc/egaop/certs";

// Read certs as strings
const caPem = fs.readFileSync(path.join(CERT_DIR, "ca-cert.pem"), "utf8");
const certPem = fs.readFileSync(path.join(CERT_DIR, "client-cert.pem"), "utf8");
const keyPem = fs.readFileSync(path.join(CERT_DIR, "client-key.pem"), "utf8");

// Create a secure context manually - this bypasses grpc-js's broken createSsl
const secureContext = tls.createSecureContext();
secureContext.context.setCA(caPem);
secureContext.context.setCert(certPem);
secureContext.context.setKey(keyPem);

// Use ChannelCredentials with the manually created context
const creds = new grpc.ChannelCredentials(secureContext, null, {
  checkServerIdentity: (hostname, cert) => {
    // Skip server identity check for internal services
    return undefined;
  }
});

const pkg = protoLoader.loadSync("/api/proto/egaop/v1/namespace.proto", {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const def = grpc.loadPackageDefinition(pkg);

const client = new def.egaop.v1.NamespaceService("127.0.0.1:50051", creds);

function rpc(method, req) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("RPC timeout")), 10000);
    client[method](req, (err, res) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(res);
    });
  });
}

async function main() {
  try {
    console.log("--- ListNamespaces ---");
    const list = await rpc("ListNamespaces", {});
    console.log(JSON.stringify(list, null, 2));

    console.log("\n--- CreateNamespace ---");
    const created = await rpc("CreateNamespace", { slug: "e2e-test", tier: "sandbox" });
    console.log(JSON.stringify(created, null, 2));

    console.log("\n--- GetNamespace ---");
    const got = await rpc("GetNamespace", { slug: "e2e-test" });
    console.log(JSON.stringify(got, null, 2));

    console.log("\nALL gRPC CALLS SUCCEEDED WITH TLS!");
    process.exit(0);
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exit(1);
  }
}

main();
