const http = require("http");

function queryOPA(input) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ input });
    const req = http.request({
      hostname: "opa",
      port: 8181,
      path: "/v1/data/egaop/execution",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", (d) => data += d);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log("--- Test 1: Same namespace (should ALLOW) ---");
  const r1 = await queryOPA({
    subject: { namespace: "test-ns", tier: "sandbox", clearance: 1 },
    resource: { namespace: "test-ns" },
    action: "read"
  });
  console.log("Result:", JSON.stringify(r1.result));
  console.log("Verdict:", r1.result.allow === true ? "PASS (ALLOWED)" : "FAIL");

  console.log("\n--- Test 2: Cross-namespace (should DENY) ---");
  const r2 = await queryOPA({
    subject: { namespace: "test-ns", tier: "sandbox", clearance: 1 },
    resource: { namespace: "other-ns" },
    action: "read"
  });
  console.log("Result:", JSON.stringify(r2.result));
  console.log("Verdict:", r2.result.allow === false ? "PASS (DENIED)" : "FAIL (SHOULD BE DENIED!)");

  console.log("\n--- Test 3: Sandbox + network egress (should DENY) ---");
  const r3 = await queryOPA({
    subject: { namespace: "test-ns", tier: "sandbox", clearance: 1 },
    resource: { namespace: "test-ns" },
    action: "network_egress"
  });
  console.log("Result:", JSON.stringify(r3.result));
  console.log("Verdict:", r3.result.allow === false ? "PASS (DENIED)" : "FAIL");
}

main().catch(e => { console.error(e); process.exit(1); });
