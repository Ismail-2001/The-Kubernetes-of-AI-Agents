import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const namespace = request.nextUrl.searchParams.get("namespace") ?? "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: Record<string, unknown>): void {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      }

      // Simulate SSE events — in production, connect to gRPC SSE bridge
      const interval = setInterval(() => {
        send("heartbeat", { timestamp: new Date().toISOString() });
      }, 15_000);

      // Cleanup on close
      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
