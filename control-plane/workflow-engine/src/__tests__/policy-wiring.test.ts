import fs from "fs";
import path from "path";

// Contract tests for the P0-3 policy enforcement wiring: workflow-engine must
// call policy-plane's HTTP API (port 15059), never OPA directly, and every
// deployment surface (compose, helm, networkpolicy) must agree.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const activities = require("../temporal/activities") as typeof import("../temporal/activities");

describe("P0-3 policy wiring contract", () => {
  it("exports a default policy-plane address on the HTTP API port (15059)", () => {
    expect(activities.DEFAULT_POLICY_PLANE_ADDR).toBe(
      "http://policy-plane:15059"
    );
  });

  it("default address never points at OPA or the gRPC port", () => {
    expect(activities.DEFAULT_POLICY_PLANE_ADDR).not.toMatch(/opa:8181/);
    expect(activities.DEFAULT_POLICY_PLANE_ADDR).not.toMatch(/:50059/);
  });

  it("docker-compose points workflow-engine at policy-plane HTTP API and defines the service", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/POLICY_PLANE_ADDR:\s*http:\/\/policy-plane:15059/);
    expect(compose).not.toMatch(/POLICY_PLANE_ADDR:\s*http:\/\/opa:8181/);
    expect(compose).toMatch(/^ {2}policy-plane:/m);
    expect(compose).toMatch(/dockerfile:\s*policy-plane\/Dockerfile/);
  });

  it("policy-plane Dockerfile exists (compose has something to build)", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "policy-plane", "Dockerfile"))).toBe(
      true
    );
  });

  it("helm workflow-engine configmap sets POLICY_PLANE_ADDR to the policy-plane service", () => {
    const cm = read(
      "charts/e-gaop/charts/workflow-engine/templates/configmap.yaml"
    );
    expect(cm).toMatch(
      /POLICY_PLANE_ADDR:\s*"http:\/\/\{\{ \.Release\.Name \}\}-policy-plane:15059"/
    );
  });

  it("helm policy-plane subchart exists with OPA_URL wired to the opa service", () => {
    const cm = read("charts/e-gaop/charts/policy-plane/templates/configmap.yaml");
    expect(cm).toMatch(
      /OPA_URL:\s*"http:\/\/\{\{ \.Release\.Name \}\}-opa:8181"/
    );
  });

  it("helm umbrella Chart.yaml declares the policy-plane subchart", () => {
    const chart = read("charts/e-gaop/Chart.yaml");
    expect(chart).toMatch(/- name: policy-plane/);
  });

  it("networkpolicy allows workflow-engine ingress to policy-plane on 15059", () => {
    const netpol = read("charts/e-gaop/templates/networkpolicy.yaml");
    // A policy selecting policy-plane must admit workflow-engine on the HTTP port.
    const ingressBlocks = netpol.split(/^---$/m).filter((b) =>
      /app\.kubernetes\.io\/name: policy-plane/.test(b) &&
      /policyTypes:\s*\n\s*- Ingress/.test(b)
    );
    expect(ingressBlocks.length).toBeGreaterThan(0);
    const admitsWorkflowEngine = ingressBlocks.some(
      (b) =>
        /app\.kubernetes\.io\/name: workflow-engine/.test(b) &&
        /port: 15059/.test(b)
    );
    expect(admitsWorkflowEngine).toBe(true);
  });

  it("networkpolicy allows workflow-engine egress to policy-plane on 15059", () => {
    const netpol = read("charts/e-gaop/templates/networkpolicy.yaml");
    const egressBlocks = netpol.split(/^---$/m).filter((b) =>
      /app\.kubernetes\.io\/name: workflow-engine/.test(b) &&
      /policyTypes:\s*\n\s*- Egress/.test(b)
    );
    expect(egressBlocks.length).toBeGreaterThan(0);
    const reachesPolicyPlane = egressBlocks.some(
      (b) =>
        /app\.kubernetes\.io\/name: policy-plane/.test(b) &&
        /port: 15059/.test(b)
    );
    expect(reachesPolicyPlane).toBe(true);
  });
});
