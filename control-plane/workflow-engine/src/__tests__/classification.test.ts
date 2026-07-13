import { classifyLLMResponse } from "../temporal/classification";

describe("classifyLLMResponse", () => {
  describe("false-positive rejection — natural language mentioning 'tool'", () => {
    it("should NOT classify 'I will use the code_interpreter tool' as tool_call", () => {
      const result = classifyLLMResponse(
        "I will use the code_interpreter tool to calculate 15 * 37."
      );
      expect(result.type).toBe("final_answer");
      expect(result.toolName).toBeUndefined();
    });

    it("should NOT classify 'The documentation says the tool is deprecated' as tool_call", () => {
      const result = classifyLLMResponse(
        'The documentation says the "tool" is deprecated.'
      );
      expect(result.type).toBe("final_answer");
      expect(result.toolName).toBeUndefined();
    });

    it("should NOT classify 'use tool: search' as tool_call", () => {
      const result = classifyLLMResponse(
        "I should use tool: search to find the answer."
      );
      expect(result.type).toBe("final_answer");
      expect(result.toolName).toBeUndefined();
    });

    it("should NOT classify a response that merely refers to 'tooling' as tool_call", () => {
      const result = classifyLLMResponse(
        "This is a great tooling setup for development."
      );
      expect(result.type).toBe("final_answer");
      expect(result.toolName).toBeUndefined();
    });

    it("should NOT classify '[tool]' without colon as tool_call", () => {
      const result = classifyLLMResponse(
        "I have a [tool] that can help."
      );
      expect(result.type).toBe("final_answer");
      expect(result.toolName).toBeUndefined();
    });

    it("should NOT classify empty content as tool_call", () => {
      const result = classifyLLMResponse("");
      expect(result.type).toBe("final_answer");
      expect(result.toolName).toBeUndefined();
    });
  });

  describe("true-positive detection — well-formed [tool: name] constructs", () => {
    it("should classify '[tool: code_interpreter]' as tool_call with correct name", () => {
      const result = classifyLLMResponse(
        "[tool: code_interpreter]"
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("code_interpreter");
    });

    it("should classify '[tool: code_interpreter] with JSON args' as tool_call and parse args", () => {
      const result = classifyLLMResponse(
        '[tool: code_interpreter] {"command": "echo hello"}'
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("code_interpreter");
      expect(result.toolArgs).toEqual({ command: "echo hello" });
    });

    it("should classify '[tool: search]' embedded in a sentence as tool_call", () => {
      const result = classifyLLMResponse(
        'I will use [tool: search] {"query": "weather"} to find the weather.'
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("search");
      expect(result.toolArgs).toEqual({ query: "weather" });
    });

    it("should classify '[tool: calculate]' with no args as tool_call with empty args", () => {
      const result = classifyLLMResponse(
        "Let me calculate: [tool: calculate]"
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("calculate");
      expect(result.toolArgs).toBeUndefined();
    });

    it("should classify '[tool: google_search]' with multi-word tool name (underscore)", () => {
      const result = classifyLLMResponse(
        '[tool: google_search] {"q": "climate"}'
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("google_search");
      expect(result.toolArgs).toEqual({ q: "climate" });
    });

    it("should classify [tool: code_interpreter] with malformed JSON args and set empty args", () => {
      const result = classifyLLMResponse(
        "[tool: code_interpreter] {bad json}"
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("code_interpreter");
      expect(result.toolArgs).toEqual({});
    });

    it("should classify [tool: code_interpreter] with inline code (no JSON) as code args", () => {
      const result = classifyLLMResponse(
        "[tool: code_interpreter]\nprint(15 * 37)"
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("code_interpreter");
      expect(result.toolArgs).toEqual({ code: "print(15 * 37)" });
    });

    it("should classify [tool: code_interpreter] with one-line inline code", () => {
      const result = classifyLLMResponse(
        "[tool: code_interpreter] print('hello')"
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("code_interpreter");
      expect(result.toolArgs).toEqual({ code: "print('hello')" });
    });

    it("should NOT treat non-code_interpreter tools with inline text as code args", () => {
      const result = classifyLLMResponse(
        "[tool: search] some query text"
      );
      expect(result.type).toBe("tool_call");
      expect(result.toolName).toBe("search");
      expect(result.toolArgs).toBeUndefined();
    });
  });
});
