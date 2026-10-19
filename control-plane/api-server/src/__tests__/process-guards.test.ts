import { classifyUncaught, isHeadersSentError, installProcessGuards } from "../process-guards";

describe("process-guards (P1-3 uncaughtException exit)", () => {
  describe("classifyUncaught", () => {
    it("suppresses ERR_STREAM_WRITE_AFTER_END (benign teardown race)", () => {
      const err = Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      expect(classifyUncaught(err)).toBe("suppress");
    });

    it("suppresses write-after-end by message even without code", () => {
      expect(classifyUncaught(new Error("write after end"))).toBe("suppress");
    });

    it("suppresses headers-already-sent errors (response already flushed)", () => {
      const err = Object.assign(new Error("Reply was already sent"), { code: "ERR_HTTP_HEADERS_SENT" });
      expect(classifyUncaught(err)).toBe("suppress");
      expect(classifyUncaught(new Error("headers have already been sent"))).toBe("suppress");
    });

    it("treats any other error as fatal (process must exit)", () => {
      expect(classifyUncaught(new Error("boom"))).toBe("fatal");
      expect(classifyUncaught(new TypeError("undefined is not a function"))).toBe("fatal");
      expect(classifyUncaught(new RangeError("Invalid time value"))).toBe("fatal");
    });

    it("treats non-Error thrown values as fatal", () => {
      expect(classifyUncaught("string failure")).toBe("fatal");
      expect(classifyUncaught(undefined)).toBe("fatal");
      expect(classifyUncaught({ code: "WEIRD" })).toBe("fatal");
    });
  });

  describe("isHeadersSentError", () => {
    it("matches code and message variants", () => {
      expect(isHeadersSentError(Object.assign(new Error("x"), { code: "ERR_HTTP_HEADERS_SENT" }))).toBe(true);
      expect(isHeadersSentError(new Error("headers have already been sent"))).toBe(true);
      expect(isHeadersSentError(new Error("unrelated"))).toBe(false);
      expect(isHeadersSentError("nope")).toBe(false);
    });
  });

  describe("installProcessGuards", () => {
    it("registers exactly one uncaughtException listener that exits on fatal errors", () => {
      process.removeAllListeners("uncaughtException");
      installProcessGuards();
      installProcessGuards(); // idempotent — must not stack duplicate listeners
      expect(process.listenerCount("uncaughtException")).toBe(1);

      const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const stderrSpy = jest.spyOn(process.stderr, "write").mockReturnValue(true);

      const listeners = process.listeners("uncaughtException");
      listeners.forEach((l) => l(new Error("fatal boom"), "uncaughtException"));

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalled();
      const logged = (stderrSpy.mock.calls as unknown as string[][]).map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Uncaught exception: fatal boom");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it("suppresses benign write-after-end without exiting", () => {
      process.removeAllListeners("uncaughtException");
      installProcessGuards();

      const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const stderrSpy = jest.spyOn(process.stderr, "write").mockReturnValue(true);

      const err = Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      process.listeners("uncaughtException").forEach((l) => l(err, "uncaughtException"));

      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });
});
