import * as grpc from "@grpc/grpc-js";
import { streamOpenAIProvider, streamLLMWithFallback } from "../index";

type TestHandler = {
  func: any;
  type: string;
  path: string;
  serialize: (value: any) => Buffer;
  deserialize: (bytes: Buffer) => any;
};

let handlers: Map<string, TestHandler>;

beforeAll(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  jest.resetModules();
  const api = require("../index");
  handlers = (api.server as any).handlers as Map<string, TestHandler>;
});

const GEN_PATH = "/egaop.v1.LLMService/Generate";
const STREAM_PATH = "/egaop.v1.LLMService/GenerateStream";
const HEALTH_PATH = "/grpc.health.v1.Health/Check";

describe("LLM Router server without API keys", () => {
  it("Generate fails with FAILED_PRECONDITION when no API key is set", async () => {
    const handler = handlers.get(GEN_PATH)!;
    const err = await new Promise<any>((resolve) => {
      handler.func(
        { request: { agent_id: "default/a", execution_id: "e", model: "gpt-4o", messages: [] } },
        (e: any) => resolve(e),
      );
    });

    expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(err.message).toContain("OPENAI_API_KEY");
  });

  it("GenerateStream emits FAILED_PRECONDITION when no API key is set", async () => {
    const handler = handlers.get(STREAM_PATH)!;
    const call = { request: { agent_id: "default/a", execution_id: "e", model: "gpt-4o", messages: [] }, write: jest.fn(), end: jest.fn(), emit: jest.fn() };
    await handler.func(call);

    expect(call.emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ code: grpc.status.FAILED_PRECONDITION }),
    );
  });

  it("health check reports SERVING when no circuit is open", async () => {
    const handler = handlers.get(HEALTH_PATH)!;
    const result = await new Promise((resolve, reject) => {
      handler.func({}, (err: any, res: any) => (err ? reject(err) : resolve(res)));
    });

    expect(result).toEqual({ status: "SERVING" });
  });

  it("health service serializers round-trip", () => {
    const handler = handlers.get(HEALTH_PATH)!;
    const serialized = handler.serialize({ status: "SERVING" });
    const deserialized = handler.deserialize(serialized);
    expect(deserialized).toEqual({ status: "SERVING" });
  });
});

describe("LLM Router helpers without API keys", () => {
  it("streamOpenAIProvider throws when the client is not configured", async () => {
    await expect(async () => {
      for await (const chunk of streamOpenAIProvider(
        [{ role: "user", content: "Hi" }],
        "gpt-4o",
        0.7,
        undefined,
      )) {
        expect(chunk).toBeDefined();
      }
    }).rejects.toThrow("OpenAI client not configured");
  });

  it("streamLLMWithFallback skips openai models and exhausts the chain", async () => {
    await expect(async () => {
      for await (const chunk of streamLLMWithFallback(
        [{ role: "user", content: "Hi" }],
        "gpt-4o",
        0.7,
        undefined,
        undefined,
      )) {
        expect(chunk).toBeDefined();
      }
    }).rejects.toThrow(/exhausted/);
  });
});
