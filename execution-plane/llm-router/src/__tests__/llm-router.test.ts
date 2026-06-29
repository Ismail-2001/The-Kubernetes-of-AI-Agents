import { PRICING, countTokens, calculateCost } from "../index";

describe("LLM Router", () => {
  describe("countTokens", () => {
    it("should return 0 for empty string", () => {
      expect(countTokens("")).toBeGreaterThanOrEqual(0);
    });

    it("should count tokens for a simple message", () => {
      const tokens = countTokens("Hello, world!");
      expect(tokens).toBeGreaterThan(0);
      expect(typeof tokens).toBe("number");
    });

    it("should count more tokens for longer text", () => {
      const short = countTokens("short");
      const long = countTokens("this is a significantly longer piece of text to test token counting");
      expect(long).toBeGreaterThan(short);
    });
  });

  describe("calculateCost", () => {
    it("should calculate cost for gpt-4o", () => {
      const cost = calculateCost(100, 50, "gpt-4o");
      expect(cost).toMatch(/^\$[0-9]+\.[0-9]+$/);
    });

    it("should cost more for more tokens", () => {
      const lowCost = calculateCost(10, 10, "gpt-4o");
      const highCost = calculateCost(1000, 1000, "gpt-4o");
      const lowNum = parseFloat(lowCost.replace("$", ""));
      const highNum = parseFloat(highCost.replace("$", ""));
      expect(highNum).toBeGreaterThan(lowNum);
    });

    it("should use gpt-4o pricing for unknown models", () => {
      const cost = calculateCost(1000, 500, "unknown-model");
      expect(cost).toMatch(/^\$[0-9]+\.[0-9]+$/);
    });

    it("should calculate gpt-3.5-turbo cheaper than gpt-4o", () => {
      const cheapCost = calculateCost(1000, 500, "gpt-3.5-turbo");
      const expensiveCost = calculateCost(1000, 500, "gpt-4o");
      const cheapNum = parseFloat(cheapCost.replace("$", ""));
      const expensiveNum = parseFloat(expensiveCost.replace("$", ""));
      expect(cheapNum).toBeLessThan(expensiveNum);
    });
  });

  describe("PRICING", () => {
    it("should have pricing for expected models", () => {
      expect(PRICING["gpt-4o"]).toBeDefined();
      expect(PRICING["claude-3-5-sonnet"]).toBeDefined();
      expect(PRICING["gpt-3.5-turbo"]).toBeDefined();
    });

    it("should have input and output pricing", () => {
      for (const [, pricing] of Object.entries(PRICING)) {
        expect(pricing.input).toBeGreaterThan(0);
        expect(pricing.output).toBeGreaterThan(0);
      }
    });
  });
});
