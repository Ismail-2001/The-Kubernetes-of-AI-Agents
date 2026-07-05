import { NextResponse } from "next/server";

const API_BASE = process.env.API_SERVER_REST_URL ?? "http://api-server:3001";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    // Set JWT as httpOnly cookie
    const response = NextResponse.json(data, { status: 200 });
    if (data.data?.token) {
      response.cookies.set("egaop_token", data.data.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 86400, // 24 hours
      });
    }

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: { message: "Auth service unavailable", code: "SERVICE_UNAVAILABLE" } },
      { status: 503 }
    );
  }
}
