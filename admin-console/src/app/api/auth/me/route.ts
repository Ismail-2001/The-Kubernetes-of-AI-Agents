import { NextResponse } from "next/server";

const API_BASE = process.env.API_SERVER_REST_URL ?? "http://api-server:3001";

export async function GET(request: Request) {
  try {
    // Get token from cookie
    const cookieHeader = request.headers.get("cookie") ?? "";
    const tokenMatch = cookieHeader.match(/egaop_token=([^;]+)/);
    if (!tokenMatch) {
      return NextResponse.json(
        { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
        { status: 401 }
      );
    }

    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokenMatch[1]}` },
      signal: AbortSignal.timeout(5000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: { message: "Auth service unavailable", code: "SERVICE_UNAVAILABLE" } },
      { status: 503 }
    );
  }
}
