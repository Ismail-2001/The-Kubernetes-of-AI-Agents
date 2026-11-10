import { InMemorySandboxRegistry, SandboxRecord } from "../sandbox/registry";

describe("InMemorySandboxRegistry", () => {
  let registry: InMemorySandboxRegistry;

  beforeEach(() => {
    registry = new InMemorySandboxRegistry(60);
  });

  it("stores and retrieves a sandbox record by executionId", async () => {
    const record: SandboxRecord = {
      executionId: "exec-123",
      agentId: "agent-abc",
      namespace: "tenant-a",
      ip: "172.30.0.10",
      token: "secret-token-32bytes-hex-format",
    };

    await registry.register(record);
    const retrieved = await registry.get("exec-123");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.executionId).toBe("exec-123");
    expect(retrieved?.agentId).toBe("agent-abc");
    expect(retrieved?.namespace).toBe("tenant-a");
    expect(retrieved?.ip).toBe("172.30.0.10");
    expect(retrieved?.token).toBe("secret-token-32bytes-hex-format");
  });

  it("returns null for non-existent executionId", async () => {
    const retrieved = await registry.get("non-existent");
    expect(retrieved).toBeNull();
  });

  it("expires records after TTL", async () => {
    const record: SandboxRecord = {
      executionId: "exec-ttl",
      agentId: "agent-1",
      namespace: "default",
      ip: "172.30.0.11",
      token: "token-ttl",
    };

    // Register with 1 second TTL
    await registry.register(record, 1);

    const immediate = await registry.get("exec-ttl");
    expect(immediate).not.toBeNull();

    // Fast-forward or wait past TTL
    await new Promise((r) => setTimeout(r, 1100));

    const expired = await registry.get("exec-ttl");
    expect(expired).toBeNull();
  });

  it("deletes records explicitly", async () => {
    const record: SandboxRecord = {
      executionId: "exec-del",
      agentId: "agent-2",
      namespace: "default",
      ip: "172.30.0.12",
      token: "token-del",
    };

    await registry.register(record);
    const deleted = await registry.delete("exec-del");
    expect(deleted).toBe(true);

    const retrieved = await registry.get("exec-del");
    expect(retrieved).toBeNull();
  });
});

