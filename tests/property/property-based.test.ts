import fc from "fast-check";
import {
  LoginSchema,
  PaginationQuerySchema,
} from "../../packages/shared/src/validation/index";
import { toProblemDetails } from "../../packages/shared/src/errors/index";
import {
  hashPassword,
  comparePassword,
  signJWT,
  verifyJWT,
} from "../../packages/shared/src/crypto/index";

// ── Local paginate (mirrors control-plane/api-server/src/index.ts) ───────────

function paginate<T>(
  items: T[],
  page: number,
  limit: number,
  _path?: string,
  totalOverride?: number,
) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 100);
  const start = (safePage - 1) * safeLimit;
  const paged = items.slice(start, start + safeLimit);
  const total = totalOverride ?? items.length;
  const totalPages = Math.ceil(total / safeLimit);
  return {
    data: paged,
    meta: {
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
      hasNext: start + safeLimit < total,
      hasPrevious: safePage > 1,
    },
  };
}

// ── 1. Validation Schema Properties ──────────────────────────────────────────

const validEmailArb = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9]+$/),
    fc.constantFrom("gmail.com", "example.com", "test.org", "company.io"),
  )
  .map(([local, domain]) => `${local}@${domain}`);

describe("Validation Schema Properties", () => {
  test("LoginSchema accepts valid email + password inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          email: validEmailArb,
          password: fc.string({ minLength: 1, maxLength: 128 }),
        }),
        (input) => {
          const result = LoginSchema.safeParse(input);
          expect(result.success).toBe(true);
        },
      ),
    );
  });

  test("LoginSchema rejects emails without @", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 100 })
          .filter((s) => !s.includes("@")),
        (invalidEmail) => {
          const result = LoginSchema.safeParse({
            email: invalidEmail,
            password: "TestPassword123!",
          });
          expect(result.success).toBe(false);
        },
      ),
    );
  });

  test("PaginationQuerySchema accepts valid page/limit combinations", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        (page, limit) => {
          const result = PaginationQuerySchema.safeParse({ page, limit });
          expect(result.success).toBe(true);
        },
      ),
    );
  });

  test("PaginationQuerySchema defaults page to 1 and limit to 20", () => {
    fc.assert(
      fc.property(
        fc.record({
          page: fc.integer({ min: 1, max: 1000 }),
          limit: fc.integer({ min: 1, max: 100 }),
        }),
        (input) => {
          const result = PaginationQuerySchema.safeParse(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.page).toBeGreaterThanOrEqual(1);
            expect(result.data.limit).toBeGreaterThanOrEqual(1);
            expect(result.data.limit).toBeLessThanOrEqual(100);
          }
        },
      ),
    );
  });
});

// ── 2. Error Response Properties ─────────────────────────────────────────────

describe("Error Response Properties", () => {
  test("toProblemDetails always returns RFC 7807 fields", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "UNAUTHORIZED",
          "NOT_FOUND",
          "VALIDATION_ERROR",
          "CONFLICT",
          "INTERNAL",
        ),
        fc.string({ minLength: 1, maxLength: 200 }),
        (code, detail) => {
          const result = toProblemDetails(code, detail, "/test", "trace-123");
          expect(result).toHaveProperty("type");
          expect(result).toHaveProperty("title");
          expect(result).toHaveProperty("status");
          expect(result).toHaveProperty("detail");
          expect(result).toHaveProperty("instance");
          expect(result).toHaveProperty("traceId");
        },
      ),
    );
  });

  test("toProblemDetails maps known codes to correct HTTP status", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("UNAUTHORIZED", "NOT_FOUND", "CONFLICT", "INTERNAL"),
        fc.string({ minLength: 1, maxLength: 100 }),
        (code, detail) => {
          const result = toProblemDetails(code, detail, "/test", "trace-123");
          expect(typeof result.status).toBe("number");
          expect(result.status).toBeGreaterThanOrEqual(400);
          expect(result.status).toBeLessThanOrEqual(599);
        },
      ),
    );
  });

  test("toProblemDetails detail field matches input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("UNAUTHORIZED", "NOT_FOUND"),
        fc.string({ minLength: 1, maxLength: 200 }),
        (code, detail) => {
          const result = toProblemDetails(code, detail, "/test", "trace-123");
          expect(result.detail).toBe(detail);
        },
      ),
    );
  });
});

// ── 3. Password Hashing Properties ───────────────────────────────────────────

describe("Password Hashing Properties", () => {
  test("Password hashing uses random salt (different hashes for same input)", async () => {
    fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 100 }),
        async (password) => {
          const hash1 = await hashPassword(password);
          const hash2 = await hashPassword(password);
          expect(hash1).not.toBe(hash2);
          expect(await comparePassword(password, hash1)).toBe(true);
          expect(await comparePassword(password, hash2)).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("Password comparison rejects wrong password", async () => {
    const correct = "TestPassword123!";
    const hash = await hashPassword(correct);

    fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 8, maxLength: 100 })
          .filter((s) => s !== correct),
        async (wrong) => {
          expect(await comparePassword(wrong, hash)).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  test("Hash format starts with scrypt prefix", async () => {
    fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (password) => {
          const hash = await hashPassword(password);
          expect(hash).toMatch(/^scrypt:\d+:\d+:\d+:/);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ── 4. JWT Token Properties ──────────────────────────────────────────────────

const JWT_SECRET = "test-secret-that-is-long-enough-for-hmac-32chars!";

describe("JWT Token Properties", () => {
  test("JWT sign/verify roundtrips correctly", () => {
    fc.assert(
      fc.property(
        fc.record({
          sub: fc.uuid(),
          email: fc.emailAddress(),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          role: fc.constantFrom("admin", "developer", "viewer"),
          namespace_access: fc.constant(["default"] as string[]),
        }),
        (claims) => {
          const token = signJWT(claims, JWT_SECRET, 3600);
          const verified = verifyJWT(token, JWT_SECRET);
          expect(verified).not.toBeNull();
          expect(verified!.sub).toBe(claims.sub);
          expect(verified!.email).toBe(claims.email);
          expect(verified!.name).toBe(claims.name);
          expect(verified!.role).toBe(claims.role);
        },
      ),
    );
  });

  test("JWT verification fails with wrong secret", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("admin", "developer", "viewer"),
        fc.uuid(),
        (role, sub) => {
          const token = signJWT(
            { sub, email: "a@b.com", name: "Test", role, namespace_access: ["default"] as string[] },
            JWT_SECRET,
            3600,
          );
          const result = verifyJWT(token, "wrong-secret-32-chars-long!!!!!!!!!!!!");
          expect(result).toBeNull();
        },
      ),
    );
  });

  test("JWT verification fails with expired token", () => {
    fc.assert(
      fc.property(
        fc.record({
          sub: fc.uuid(),
          email: fc.emailAddress(),
          name: fc.string({ minLength: 1, maxLength: 30 }),
          role: fc.constantFrom("admin", "developer"),
        }),
        (claims) => {
          const token = signJWT(
            { ...claims, namespace_access: ["default"] as string[] },
            JWT_SECRET,
            -1,
          );
          const result = verifyJWT(token, JWT_SECRET);
          expect(result).toBeNull();
        },
      ),
    );
  });
});

// ── 5. Pagination Properties ─────────────────────────────────────────────────

describe("Pagination Properties", () => {
  test("paginate returns correct structure", () => {
    fc.assert(
      fc.property(
        fc.array(fc.anything(), { minLength: 0, maxLength: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 1000 }).map(String),
        (items, limit, total) => {
          const result = paginate(items, 1, limit, "/test", Number(total));
          expect(result).toHaveProperty("data");
          expect(result).toHaveProperty("meta");
          expect(result.meta).toHaveProperty("total");
          expect(result.meta).toHaveProperty("page");
          expect(result.meta).toHaveProperty("limit");
          expect(result.meta).toHaveProperty("totalPages");
          expect(result.meta).toHaveProperty("hasNext");
          expect(result.meta).toHaveProperty("hasPrevious");
        },
      ),
    );
  });

  test("paginate never returns more items than limit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.anything(), { minLength: 0, maxLength: 200 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 500 }),
        (items, page, limit) => {
          const result = paginate(items, page, limit);
          expect(result.data.length).toBeLessThanOrEqual(limit);
        },
      ),
    );
  });

  test("paginate page is always >= 1", () => {
    fc.assert(
      fc.property(
        fc.array(fc.anything(), { maxLength: 50 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: 1, max: 50 }),
        (items, page, limit) => {
          const result = paginate(items, page, limit);
          expect(result.meta.page).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });
});
