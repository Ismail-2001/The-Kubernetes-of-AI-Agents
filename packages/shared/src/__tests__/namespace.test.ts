import {
  validateSlug,
  isNamespaceSuspended,
  isNamespaceDeleted,
  NamespaceTier,
  DEFAULT_QUOTAS,
  type Namespace,
} from "../namespaces/model.js";

describe("validateSlug", () => {
  it("should accept valid slugs", () => {
    expect(validateSlug("my-namespace")).toBe(true);
    expect(validateSlug("test-123")).toBe(true);
    expect(validateSlug("abc")).toBe(true);
    expect(validateSlug("a".repeat(63))).toBe(true);
  });

  it("should reject slugs with uppercase", () => {
    expect(validateSlug("My-Namespace")).toBe(false);
  });

  it("should reject slugs with underscores", () => {
    expect(validateSlug("my_namespace")).toBe(false);
  });

  it("should reject slugs with spaces", () => {
    expect(validateSlug("my namespace")).toBe(false);
  });

  it("should reject slugs shorter than 3 chars", () => {
    expect(validateSlug("ab")).toBe(false);
    expect(validateSlug("a")).toBe(false);
    expect(validateSlug("")).toBe(false);
  });

  it("should reject slugs longer than 63 chars", () => {
    expect(validateSlug("a".repeat(64))).toBe(false);
  });

  it("should reject slugs with special characters", () => {
    expect(validateSlug("my.namespace")).toBe(false);
    expect(validateSlug("my@namespace")).toBe(false);
    expect(validateSlug("my/namespace")).toBe(false);
  });
});

describe("isNamespaceSuspended", () => {
  const baseNs: Namespace = {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "test-ns",
    displayName: "Test",
    tier: NamespaceTier.STANDARD,
    ownerId: "user-1",
    quotas: DEFAULT_QUOTAS.standard,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("should return false for active namespace", () => {
    expect(isNamespaceSuspended(baseNs)).toBe(false);
  });

  it("should return true when suspendedAt is set", () => {
    expect(isNamespaceSuspended({ ...baseNs, suspendedAt: new Date() })).toBe(true);
  });

  it("should return false when both suspended and deleted", () => {
    expect(isNamespaceSuspended({
      ...baseNs,
      suspendedAt: new Date(),
      deletedAt: new Date(),
    })).toBe(false);
  });
});

describe("isNamespaceDeleted", () => {
  const baseNs: Namespace = {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "test-ns",
    displayName: "Test",
    tier: NamespaceTier.STANDARD,
    ownerId: "user-1",
    quotas: DEFAULT_QUOTAS.standard,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("should return false for active namespace", () => {
    expect(isNamespaceDeleted(baseNs)).toBe(false);
  });

  it("should return true when deletedAt is set", () => {
    expect(isNamespaceDeleted({ ...baseNs, deletedAt: new Date() })).toBe(true);
  });
});

describe("DEFAULT_QUOTAS", () => {
  it("should have quotas for all tiers", () => {
    expect(DEFAULT_QUOTAS.sandbox).toBeDefined();
    expect(DEFAULT_QUOTAS.standard).toBeDefined();
    expect(DEFAULT_QUOTAS.enterprise).toBeDefined();
  });

  it("should have enterprise > standard > sandbox limits", () => {
    expect(DEFAULT_QUOTAS.enterprise.maxAgents).toBeGreaterThan(DEFAULT_QUOTAS.standard.maxAgents);
    expect(DEFAULT_QUOTAS.standard.maxAgents).toBeGreaterThan(DEFAULT_QUOTAS.sandbox.maxAgents);
    expect(DEFAULT_QUOTAS.enterprise.maxConcurrentExecutions).toBeGreaterThan(
      DEFAULT_QUOTAS.standard.maxConcurrentExecutions
    );
  });
});
