import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, storeTokens } from "@/lib/whoop";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  const redirectTo = (ok: boolean) => {
    const res = NextResponse.redirect(
      new URL(ok ? "/today" : "/today?whoop=error", url.origin)
    );
    res.cookies.delete("whoop_oauth_state");
    return res;
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get("whoop_oauth_state")?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    console.error("[whoop] callback rejected: missing code or state mismatch");
    return redirectTo(false);
  }

  const tokens = await exchangeCode(code, `${url.origin}/api/whoop/callback`);
  if (!tokens) return redirectTo(false);

  const stored = await storeTokens(ATHLETE_ID, tokens);
  return redirectTo(stored);
}
