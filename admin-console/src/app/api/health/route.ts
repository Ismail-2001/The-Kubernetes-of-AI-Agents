import { NextResponse } from "next/server";

const API_HEALTH = process.env.API_SERVER_HEALTH_URL ?? "http://api-server:15051";

export async function GET() {
  try {
    const res = await fetch(`${API_HEALTH}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    const reachable = res.ok;
    return NextResponse.json(
      { status: reachable ? "ok" : "degraded", apiServerReachable: reachable },
      { status: reachable ? 200 : 503 }
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", apiServerReachable: false },
      { status: 503 }
    );
  }
}
