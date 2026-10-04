import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { safeEqual } from "@/lib/whoop";
import { runMorningChain } from "@/lib/morning";
import { pushLog } from "@/lib/debugLog";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

// The chain (sync → summarise → pulse ‖ deep) runs after the 200 via
// waitUntil and needs the full Vercel Hobby (Fluid compute) cap.
export const maxDuration = 300;

// Replay tolerance. Whoop retries failed deliveries over about an hour and
// its docs don't say whether retries are re-signed with a fresh timestamp,
// so this is deliberately loose. A replayed recovery.updated is harmless —
// the chain is idempotent — the signature is what matters.
const MAX_TIMESTAMP_SKEW_MS = 2 * 60 * 60_000;

type WhoopWebhookEvent = {
  user_id?: number;
  id?: string;
  type?: string;
  trace_id?: string;
};

/**
 * Whoop v2 webhook signature:
 *   X-WHOOP-Signature = base64(HMAC-SHA256(timestamp + rawBody, client_secret))
 *   X-WHOOP-Signature-Timestamp = milliseconds since epoch
 * The timestamp string is concatenated directly onto the raw body, no
 * separator. The key is the app's client secret — Whoop issues no separate
 * webhook secret. https://developer.whoop.com/docs/developing/webhooks/
 */
function verifySignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret: string
): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_TIMESTAMP_SKEW_MS) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");
  return safeEqual(signature, expected);
}

export async function POST(request: Request) {
  const secret = process.env.WHOOP_CLIENT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  // Raw text, not .json() — the signature covers the exact bytes sent.
  const rawBody = await request.text();
  const valid = verifySignature(
    rawBody,
    request.headers.get("x-whoop-signature"),
    request.headers.get("x-whoop-signature-timestamp"),
    secret
  );
  if (!valid) {
    pushLog("error", { message: "whoop webhook: invalid signature" });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: WhoopWebhookEvent;
  try {
    event = JSON.parse(rawBody) as WhoopWebhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // A scored recovery is the "they woke up" signal. For recovery.updated the
  // id is the associated sleep (UUID); the chain resolves the recovery from
  // it. Every other event type is acknowledged and dropped.
  if (event.type !== "recovery.updated" || typeof event.id !== "string") {
    return NextResponse.json({ ignored: event.type ?? "unknown" });
  }

  // Respond now; Whoop never waits on the chain.
  waitUntil(
    runMorningChain(ATHLETE_ID, event.id, event.trace_id).catch((err) => {
      console.error("[morning] chain rejected:", err);
    })
  );
  return NextResponse.json({ accepted: true });
}
