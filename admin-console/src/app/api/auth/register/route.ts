import { NextResponse } from "next/server";

const API_BASE = process.env.API_SERVER_REST_URL ?? "http://api-server:3001";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { error: { message: "Auth service unavailable", code: "SERVICE_UNAVAILABLE" } },
      { status: 503 }
    );
  }
}
