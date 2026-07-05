import { NextResponse } from "next/server";

export async function POST() {
  // Clear the JWT cookie
  const response = NextResponse.json({ data: { message: "Logged out" } });
  response.cookies.set("egaop_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
