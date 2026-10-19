import { verifyServiceToken } from "../service-token";

function fakeReq(headers: Record<string, string | undefined> = {}) {
  return { headers } as unknown as { headers: Record<string, string | string[] | undefined> };
}

describe("memory-plane verifyServiceToken (P1-4)", () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_TOKEN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL;
  });

  it("denies when INTERNAL_SERVICE_TOKEN is not configured (fail-closed)", () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    expect(verifyServiceToken(fakeReq())).toBe(false);
    expect(verifyServiceToken(fakeReq({ "x-service-token": "anything" }))).toBe(false);
  });

  it("denies when expected token set but header missing", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "svc-token-expected-0123456789abcdef";
    expect(verifyServiceToken(fakeReq())).toBe(false);
  });

  it("denies mismatched token", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "svc-token-expected-0123456789abcdef";
    expect(verifyServiceToken(fakeReq({ "x-service-token": "svc-token-wrong-0123456789abcdef" }))).toBe(false);
  });

  it("allows matching token", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "svc-token-expected-0123456789abcdef";
    expect(verifyServiceToken(fakeReq({ "x-service-token": "svc-token-expected-0123456789abcdef" }))).toBe(true);
  });
});
