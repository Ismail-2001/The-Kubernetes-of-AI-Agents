import { requireNamespace, resolveScope, namespaceError, isValidNamespace } from "../grpc/namespace.js";

function callWith(ns?: string) {
  return {
    metadata: {
      get: (k: string) => (k === "x-egaop-namespace" && ns !== undefined ? [ns] : []),
    },
  };
}

describe("grpc namespace contract", () => {
  describe("isValidNamespace", () => {
    it("accepts dns-1123 labels", () => {
      expect(isValidNamespace("default")).toBe(true);
      expect(isValidNamespace("team-alpha")).toBe(true);
      expect(isValidNamespace("a1")).toBe(true);
    });
    it("rejects malformed values", () => {
      expect(isValidNamespace("")).toBe(false);
      expect(isValidNamespace("Team-Alpha")).toBe(false);
      expect(isValidNamespace("-lead")).toBe(false);
      expect(isValidNamespace("trail-")).toBe(false);
      expect(isValidNamespace("under_score")).toBe(false);
      expect(isValidNamespace("a".repeat(64))).toBe(false);
    });
  });

  describe("requireNamespace", () => {
    it("returns the metadata namespace", () => {
      expect(requireNamespace(callWith("team-beta"))).toBe("team-beta");
    });
    it("fails closed on missing metadata", () => {
      expect(() => requireNamespace(callWith(undefined))).toThrow(/Missing or invalid/);
    });
    it("fails closed on malformed metadata", () => {
      expect(() => requireNamespace(callWith("NOT valid!"))).toThrow(/Missing or invalid/);
    });
    it("tags errors INVALID_ARGUMENT", () => {
      try {
        requireNamespace(callWith(undefined));
        expect.unreachable();
      } catch (err) {
        expect((err as { code: number }).code).toBe(3);
      }
    });
  });

  describe("resolveScope", () => {
    it("uses metadata namespace when body is absent", () => {
      expect(resolveScope(callWith("team-beta"), undefined)).toEqual({ namespace: "team-beta", crossNamespace: false });
      expect(resolveScope(callWith("team-beta"), "")).toEqual({ namespace: "team-beta", crossNamespace: false });
    });
    it("agrees when body matches metadata", () => {
      expect(resolveScope(callWith("team-beta"), "team-beta")).toEqual({ namespace: "team-beta", crossNamespace: false });
    });
    it("flags cross-namespace probes", () => {
      expect(resolveScope(callWith("team-beta"), "team-alpha")).toEqual({ namespace: "team-beta", crossNamespace: true });
    });
  });

  describe("namespaceError", () => {
    it("carries INVALID_ARGUMENT code", () => {
      expect(namespaceError("x").code).toBe(3);
    });
  });
});
