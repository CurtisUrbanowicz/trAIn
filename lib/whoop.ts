import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// Whoop API v2 (v1 sunset October 2025)
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

export const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_SCOPES = "read:recovery read:sleep read:cycles offline";

// ── Service-role client — wearable_tokens is RLS deny-all, so only this
// client (never the browser's anon key) can touch it. Null when the env
// var isn't set (e.g. local dev), in which case token ops no-op.
// SUPABASE_SERVICE_ROLE_KEY is a new-format sb_secret_… key: supabase-js
// passes it through as the apikey header and the gateway maps it to
// service role (RLS bypass) — no JWT involved.
let serviceClient: SupabaseClient | null = null;
function getServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!serviceClient) {
    serviceClient = createClient(url, key, {
      // Server-side key client: no user sessions, ever
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}

// ── Token lifecycle ─────────────────────────────────────────────

export type WhoopTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
};

async function requestToken(
  params: Record<string, string>
): Promise<WhoopTokenResponse | null> {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    // Status only — never log bodies or params from the token endpoint
    console.error(`[whoop] token request failed: ${res.status}`);
    return null;
  }
  return (await res.json()) as WhoopTokenResponse;
}

export function exchangeCode(
  code: string,
  redirectUri: string
): Promise<WhoopTokenResponse | null> {
  return requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}

export async function storeTokens(
  athleteId: string,
  tok: WhoopTokenResponse
): Promise<boolean> {
  const svc = getServiceClient();
  if (!svc) {
    console.error("[whoop] SUPABASE_SERVICE_ROLE_KEY not set — cannot store tokens");
    return false;
  }
  const { error } = await svc.from("wearable_tokens").upsert(
    {
      athlete_id: athleteId,
      provider: "whoop",
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      // 60s early expiry so getValidToken refreshes before the edge
      expires_at: new Date(
        Date.now() + (tok.expires_in - 60) * 1000
      ).toISOString(),
      scopes: tok.scope ?? WHOOP_SCOPES,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "athlete_id,provider" }
  );
  if (error) {
    console.error("[whoop] failed to store tokens:", error.message);
    return false;
  }
  return true;
}

/**
 * Returns a usable access token for the athlete, refreshing (and
 * persisting the rotated refresh token) when expired. Null when no
 * token row exists, the service client is unavailable, or refresh fails.
 */
export async function getValidToken(athleteId: string): Promise<string | null> {
  const svc = getServiceClient();
  if (!svc) return null;

  const { data, error } = await svc
    .from("wearable_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("athlete_id", athleteId)
    .eq("provider", "whoop")
    .maybeSingle();

  if (error || !data) return null;

  if (new Date(data.expires_at).getTime() - Date.now() > 60_000) {
    return data.access_token;
  }

  // Whoop rotates refresh tokens — store the new pair immediately
  const refreshed = await requestToken({
    grant_type: "refresh_token",
    refresh_token: data.refresh_token,
    scope: "offline",
  });
  if (!refreshed) return null;
  await storeTokens(athleteId, refreshed);
  return refreshed.access_token;
}

// ── Whoop data fetch ────────────────────────────────────────────

export type WhoopRecovery = {
  cycle_id: number;
  sleep_id: string;
  created_at: string;
  score_state: string;
  score?: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
  } | null;
};

export type WhoopSleep = {
  id: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: string;
  score?: {
    stage_summary?: {
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
    };
  } | null;
};

async function whoopGet<T>(token: string, path: string): Promise<T | null> {
  const res = await fetch(`${WHOOP_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`[whoop] GET ${path.split("?")[0]} failed: ${res.status}`);
    return null;
  }
  return (await res.json()) as T;
}

type Paged<T> = { records: T[]; next_token: string | null };

async function whoopGetAll<T>(
  token: string,
  path: string,
  params: Record<string, string>
): Promise<T[]> {
  const records: T[] = [];
  let nextToken: string | null = null;
  // Hard page cap — 365 days of records fits well within this
  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ ...params, limit: "25" });
    if (nextToken) qs.set("nextToken", nextToken);
    const res = await fetch(`${WHOOP_API_BASE}${path}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[whoop] GET ${path} failed: ${res.status}`);
      break;
    }
    const body = (await res.json()) as Paged<T>;
    records.push(...(body.records ?? []));
    nextToken = body.next_token;
    if (!nextToken) break;
  }
  return records;
}

/**
 * First unfiltered page of recoveries (docs say newest-first, but callers
 * must sort by created_at themselves — observed ordering has not matched
 * the docs for all accounts).
 */
export async function getRecentRecoveries(
  token: string
): Promise<WhoopRecovery[]> {
  const res = await whoopGet<Paged<WhoopRecovery>>(
    token,
    "/v2/recovery?limit=25"
  );
  return res?.records ?? [];
}

export function getSleepById(
  token: string,
  sleepId: string
): Promise<WhoopSleep | null> {
  return whoopGet<WhoopSleep>(token, `/v2/activity/sleep/${sleepId}`);
}

export function getRecoveriesInRange(
  token: string,
  startIso: string,
  endIso: string
): Promise<WhoopRecovery[]> {
  return whoopGetAll<WhoopRecovery>(token, "/v2/recovery", {
    start: startIso,
    end: endIso,
  });
}

export function getSleepsInRange(
  token: string,
  startIso: string,
  endIso: string
): Promise<WhoopSleep[]> {
  return whoopGetAll<WhoopSleep>(token, "/v2/activity/sleep", {
    start: startIso,
    end: endIso,
  });
}

// ── Readiness mapping ───────────────────────────────────────────

export type ReadinessValues = {
  date: string;
  hrv: number | null;
  rhr: number | null;
  recovery_score: number | null;
  sleep_hours: number | null;
};

/** "2026-10-04T06:12:00.000Z" + "+01:00" → local calendar date "2026-10-04" */
function localDateFromInstantAndOffset(
  iso: string,
  offset: string
): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const m = offset.match(/^([+-])(\d{2}):(\d{2})/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const offsetMs = sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  const local = new Date(ms + offsetMs);
  const yy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function localDateInZone(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return localDateInZone(iso, "Europe/London");
  }
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTimezone(timeZone: string): string {
  return (
    localDateInZone(new Date().toISOString(), timeZone) ??
    new Date().toISOString().slice(0, 10)
  );
}

export async function getAthleteTimezone(athleteId: string): Promise<string> {
  const { data } = await supabase
    .from("athletes")
    .select("timezone")
    .eq("id", athleteId)
    .maybeSingle();
  return data?.timezone ?? "Europe/London";
}

/**
 * Maps a scored Whoop recovery (+ its sleep) to a readiness row.
 * Wake date: sleep.end shifted by Whoop's own timezone_offset (correct
 * across travel/DST); falls back to recovery.created_at rendered in the
 * athlete's stored IANA timezone. Null for unscored/calibrating records.
 */
export function mapRecoveryToReadiness(
  recovery: WhoopRecovery,
  sleep: WhoopSleep | null,
  fallbackTimezone: string
): ReadinessValues | null {
  if (
    recovery.score_state !== "SCORED" ||
    !recovery.score ||
    recovery.score.user_calibrating
  ) {
    return null;
  }

  let date: string | null = null;
  if (sleep?.end && sleep.timezone_offset) {
    date = localDateFromInstantAndOffset(sleep.end, sleep.timezone_offset);
  }
  if (!date) {
    date = localDateInZone(recovery.created_at, fallbackTimezone);
  }
  if (!date) return null;

  let sleepHours: number | null = null;
  const ss = sleep?.score?.stage_summary;
  if (ss) {
    // "Time asleep" as the Whoop app shows it: light + slow-wave + REM
    const asleepMs =
      (ss.total_light_sleep_time_milli ?? 0) +
      (ss.total_slow_wave_sleep_time_milli ?? 0) +
      (ss.total_rem_sleep_time_milli ?? 0);
    if (asleepMs > 0) {
      sleepHours = Math.round((asleepMs / 3_600_000) * 100) / 100;
    }
  }

  return {
    date,
    recovery_score: Math.round(recovery.score.recovery_score),
    rhr: Math.round(recovery.score.resting_heart_rate),
    hrv: Math.round(recovery.score.hrv_rmssd_milli * 10) / 10,
    sleep_hours: sleepHours,
  };
}

// ── Readiness writes (anon client — readiness is open like all app tables) ──

export async function hasReadinessForDate(
  athleteId: string,
  date: string
): Promise<boolean> {
  const { data } = await supabase
    .from("readiness")
    .select("id")
    .eq("athlete_id", athleteId)
    .eq("date", date)
    .limit(1);
  return (data ?? []).length > 0;
}

export type InsertOutcome = "written" | "duplicate" | "error";

export async function insertWhoopReadiness(
  athleteId: string,
  values: ReadinessValues
): Promise<InsertOutcome> {
  const { error } = await supabase.from("readiness").insert({
    athlete_id: athleteId,
    date: values.date,
    hrv: values.hrv,
    rhr: values.rhr,
    recovery_score: values.recovery_score,
    sleep_hours: values.sleep_hours,
    source: "whoop",
    timestamp: new Date().toISOString(),
  });
  if (!error) return "written";
  // 23505: a concurrent run already wrote this date (unique index
  // readiness_whoop_one_per_date) — skipped, not a failure
  if (error.code === "23505") return "duplicate";
  console.error("[whoop] readiness insert failed:", error.message);
  return "error";
}
