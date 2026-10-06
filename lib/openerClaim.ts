import "server-only";
import { randomUUID } from "crypto";
import { supabase } from "./supabase";

/**
 * One opener per athlete, date and tab.
 *
 * A tab's opener fires from the client when the day has no saved messages.
 * A remount or reload mid-opener (tab switch, refresh) also hydrates
 * nothing — the reply isn't saved yet — and would start a second turn. The
 * claim row makes the turn run once: a later request finds the claim held,
 * the route answers {"t":"held"} without a turn, and the client keeps its
 * dots and waits for the saved reply via realtime.
 *
 * Same shape as the morning chain's claim (lib/morning.ts): the insert
 * wins; on conflict, a claim older than the route's 5-minute limit is
 * presumed dead and reclaimed by rotating claim_token, so two reclaimers
 * cannot both win. The holder releases its claim when the turn fails or
 * persists nothing, so the next open can retry.
 */

/** A claim older than this (the chat route's maxDuration) is presumed dead. */
export const OPENER_CLAIM_STALE_MS = 5 * 60_000;

export type OpenerClaimOutcome = "claimed" | "reclaimed" | "held" | "error";

export type OpenerClaim = {
  outcome: OpenerClaimOutcome;
  // The holder's token — null when held or when the claim itself failed
  token: string | null;
};

export async function claimOpener(
  athleteId: string,
  date: string,
  tab: string
): Promise<OpenerClaim> {
  const token = randomUUID();
  const { error: insertError } = await supabase.from("opener_claims").insert({
    athlete_id: athleteId,
    date,
    tab,
    claim_token: token,
  });
  if (!insertError) return { outcome: "claimed", token };
  if (insertError.code !== "23505") {
    console.error("[opener] claim insert failed:", insertError.message);
    return { outcome: "error", token: null };
  }

  const { data: row } = await supabase
    .from("opener_claims")
    .select("started_at, claim_token")
    .eq("athlete_id", athleteId)
    .eq("date", date)
    .eq("tab", tab)
    .maybeSingle();
  if (!row) return { outcome: "error", token: null };

  if (Date.now() - Date.parse(row.started_at) < OPENER_CLAIM_STALE_MS) {
    return { outcome: "held", token: null };
  }

  // Stale claim: reclaim. Matching on claim_token means only one of two
  // concurrent reclaimers wins.
  const { data: updated } = await supabase
    .from("opener_claims")
    .update({ started_at: new Date().toISOString(), claim_token: token })
    .eq("athlete_id", athleteId)
    .eq("date", date)
    .eq("tab", tab)
    .eq("claim_token", row.claim_token)
    .select("athlete_id");
  return (updated ?? []).length > 0
    ? { outcome: "reclaimed", token }
    : { outcome: "held", token: null };
}

/**
 * The turn failed or persisted nothing: drop the claim so the next open
 * runs the opener. Only the holder's token matches, so a late release
 * never removes a claim someone else has since taken.
 */
export async function releaseOpener(
  athleteId: string,
  date: string,
  tab: string,
  token: string
): Promise<void> {
  const { error } = await supabase
    .from("opener_claims")
    .delete()
    .eq("athlete_id", athleteId)
    .eq("date", date)
    .eq("tab", tab)
    .eq("claim_token", token);
  if (error) console.error("[opener] claim release failed:", error.message);
}
