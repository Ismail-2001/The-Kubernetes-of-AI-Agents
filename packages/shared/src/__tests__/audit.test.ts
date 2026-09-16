import { createAuditEntry, getAuditChain, verifyAuditChain } from "../audit/index.js";
import { getPool } from "../db.js";

jest.mock("../db.js", () => ({
  getPool: jest.fn(),
}));

const mockGetPool = getPool as jest.Mock;

let stderrSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;

beforeEach(() => {
  process.env.AUDIT_CHAIN_ID = "test-chain";
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.AUDIT_CHAIN_ID;
  process.env.NODE_ENV = "test";
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  mockGetPool.mockReset();
});

describe("Audit Module", () => {
  it("should create a signed audit entry", () => {
    const entry = createAuditEntry(
      "sandbox.create",
      "info",
      { type: "service", id: "sandbox-runtime" },
      { name: "CreateSandbox", result: "allowed" },
      { type: "sandbox", id: "sandbox-1" },
    );

    expect(entry.version).toBe("egaop-audit/1.0");
    expect(entry.eventType).toBe("sandbox.create");
    expect(entry.severity).toBe("info");
    expect(entry.actor.id).toBe("sandbox-runtime");
    expect(entry.target?.id).toBe("sandbox-1");
    expect(entry.action.name).toBe("CreateSandbox");
    expect(entry.action.result).toBe("allowed");
    expect(entry.integrity.previousHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.integrity.chainId).toBe("test-chain");
    expect(entry.eventId).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
  });

  it("should chain entries via previousHash", () => {
    const entry1 = createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "user-1" },
      { name: "Login", result: "allowed" },
    );
    const entry2 = createAuditEntry(
      "policy.decision",
      "info",
      { type: "service", id: "opa" },
      { name: "AllowAction", result: "allowed" },
    );

    // entry2's previousHash should be the hash of entry1's data
    expect(entry2.integrity.previousHash).not.toBe(entry1.integrity.previousHash);
    expect(entry2.integrity.previousHash).not.toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("should store entries and retrieve chain", () => {
    createAuditEntry(
      "sandbox.create",
      "info",
      { type: "service", id: "test" },
      { name: "Create", result: "allowed" },
    );

    const chain = getAuditChain("test-chain");
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[chain.length - 1]?.eventType).toBe("sandbox.create");
  });

  it("should verify a valid chain", () => {
    // Use a unique chain ID to get a clean chain
    const chainId = "verify-test-chain";
    process.env.AUDIT_CHAIN_ID = chainId;

    createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "alice" },
      { name: "Login", result: "allowed" },
    );
    createAuditEntry(
      "secret.access",
      "warn",
      { type: "service", id: "vault" },
      { name: "ReadSecret", result: "allowed" },
      { type: "secret", id: "enc-key" },
    );

    const chain = getAuditChain(chainId);
    expect(verifyAuditChain(chain)).toBe(true);

    process.env.AUDIT_CHAIN_ID = "test-chain";
  });

  it("should detect chain tampering", () => {
    const chainId = "tamper-test-chain";
    process.env.AUDIT_CHAIN_ID = chainId;

    createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "bob" },
      { name: "Login", result: "allowed" },
    );
    createAuditEntry(
      "config.change",
      "warn",
      { type: "user", id: "admin" },
      { name: "UpdateConfig", result: "allowed" },
    );

    const chain = getAuditChain(chainId);
    chain[0]!.action.result = "denied";

    expect(verifyAuditChain(chain)).toBe(false);
    process.env.AUDIT_CHAIN_ID = "test-chain";
  });

  it("should handle all event types", () => {
    const eventTypes = [
      "auth.login", "auth.logout", "auth.token_refresh", "auth.failed_login",
      "policy.decision", "policy.deny",
      "secret.access", "secret.create", "secret.update", "secret.delete",
      "sandbox.create", "sandbox.destroy", "sandbox.exec",
      "namespace.create", "namespace.update", "namespace.suspend", "namespace.delete",
      "agent.create", "agent.execution_start", "agent.execution_end", "agent.tool_call",
      "config.change", "certificate.rotate", "key.rotate",
    ] as const;

    for (const eventType of eventTypes) {
      const entry = createAuditEntry(
        eventType,
        "info",
        { type: "system", id: "test" },
        { name: "Test", result: "allowed" },
      );
      expect(entry.eventType).toBe(eventType);
    }

    const chain = getAuditChain("test-chain");
    expect(chain.length).toBeGreaterThanOrEqual(eventTypes.length);
  });

  it("should write error/critical entries to stderr", () => {
    createAuditEntry(
      "policy.deny",
      "critical",
      { type: "service", id: "opa" },
      { name: "Deny", result: "denied" },
    );
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("should write info entries to stdout", () => {
    createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "u" },
      { name: "Login", result: "allowed" },
    );
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("should cap the in-memory chain at 10000 entries", () => {
    const chainId = "cap-chain";
    process.env.AUDIT_CHAIN_ID = chainId;
    for (let i = 0; i < 10010; i++) {
      createAuditEntry(
        "agent.tool_call",
        "info",
        { type: "agent", id: `agent-${i}` },
        { name: "ToolCall", result: "allowed" },
      );
    }
    expect(getAuditChain(chainId).length).toBe(10000);
  });

  it("should persist entries to postgres outside of test env", async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    mockGetPool.mockResolvedValue(pool);
    process.env.NODE_ENV = "production";
    createAuditEntry(
      "auth.login",
      "info",
      { type: "user", id: "u" },
      { name: "Login", result: "allowed" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(pool.query).toHaveBeenCalled();
    expect(mockGetPool).toHaveBeenCalled();
  });

  it("should log a failure when persistence errors", async () => {
    mockGetPool.mockRejectedValue(new Error("db down"));
    process.env.NODE_ENV = "production";
    createAuditEntry(
      "secret.access",
      "warn",
      { type: "service", id: "vault" },
      { name: "ReadSecret", result: "allowed" },
    );
    // Wait for fire-and-forget retry (3 retries with exponential backoff ~ 700ms total)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed after"));
  });
});
