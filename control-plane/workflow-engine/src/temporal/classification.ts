export interface ClassificationResult {
  type: "final_answer" | "tool_call";
  toolName: string | undefined;
  toolArgs: Record<string, unknown> | undefined;
}

export function classifyLLMResponse(content: string): ClassificationResult {
  const toolCallBracketPattern = /\[tool:\s*(\w+)\]/i;
  const bracketMatch = content.match(toolCallBracketPattern);

  if (bracketMatch?.[1]) {
    const toolName = bracketMatch[1];
    let toolArgs: Record<string, unknown> | undefined;

    // Try JSON args after the tool tag: [tool:name] {"code": "..."}
    const jsonArgsMatch = content.match(/\[tool:\s*\w+\]\s*(\{(?:[^{}]|(?:\{[^{}]*\}))*\})/s);
    if (jsonArgsMatch?.[1]) {
      try {
        toolArgs = JSON.parse(jsonArgsMatch[1]);
      } catch {
        toolArgs = {};
      }
    } else {
      // No JSON found — treat remaining text after the tool tag as inline code (code_interpreter),
      // or try args=key:value pairs, or fall back to empty.
      const rest = content.slice(bracketMatch.index! + bracketMatch[0].length).trim();
      if (toolName === "code_interpreter" && rest) {
        toolArgs = { code: rest };
      }
    }

    return { type: "tool_call", toolName, toolArgs };
  }

  return { type: "final_answer", toolName: undefined, toolArgs: undefined };
}
