const mockCreate = jest.fn();
jest.mock("openai", () => {
  return {
    __esModule: true,
    default: class {
      chat = { completions: { create: mockCreate } };
    },
  };
});

let handlers: Map<string, { func: any }>;
let rateLimiter: any;

beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.ANTHROPIC_API_KEY;
  jest.resetModules();
  const api = require("../index");
  handlers = (api.server as any).handlers as Map<string, { func: any }>;
  rateLimiter = api.rateLimiter;
});

afterEach(() => {
  jest.clearAllMocks();
  rateLimiter.dispose();
});

const GEN_PATH = "/egaop.v1.LLMService/Generate";

function runGenerate(model: string): Promise<any> {
  const handler = handlers.get(GEN_PATH)!;
  return new Promise((resolve) => {
    handler.func(
      {
        request: {
          agent_id: "default/agent-1",
          execution_id: "exec-1",
          model,
          messages: [{ role: "user", content: "Hello" }],
          temperature: 0.7,
        },
      },
      (err: any, result?: any) => resolve({ err, result })
    );
  });
}

describe("LLM Router with Anthropic key missing", () => {
  it("falls back to OpenAI when a Claude model is requested", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "fallback from openai", tool_calls: undefined } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const { err, result } = await runGenerate("claude-3-5-sonnet-20241022");

    expect(err).toBeNull();
    expect(result.content).toBe("fallback from openai");
    expect(result.model_used).toBe("gpt-4o");
    expect(mockCreate).toHaveBeenCalled();
  });
});
