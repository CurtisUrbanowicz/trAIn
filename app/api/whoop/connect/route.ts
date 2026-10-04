import { NextResponse } from "next/server";
import { WHOOP_AUTH_URL, WHOOP_SCOPES } from "@/lib/whoop";

export async function GET(request: Request) {
  const clientId = process.env.WHOOP_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Whoop is not configured" },
      { status: 500 }
    );
  }

  const origin = new URL(request.url).origin;
  const state = crypto.randomUUID();

  const url = new URL(WHOOP_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${origin}/api/whoop/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", WHOOP_SCOPES);
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url);
  // CSRF guard — verified against the state param in /callback
  res.cookies.set("whoop_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
