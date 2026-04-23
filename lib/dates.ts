// Client-side date helpers. All functions use local time.
// For UTC equivalents used by server/API routes, see lib/context.ts
// (getWeekStartMondayUtc, formatDate) and app/api/* inline helpers.

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Today as YYYY-MM-DD in the user's local timezone. */
export function getLocalDate(): string {
  return dateToYmd(new Date());
}

/** Convert a `Date` to YYYY-MM-DD in local time. */
export function dateToYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Add (or subtract) `days` to a YYYY-MM-DD string, local time. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + days);
  return dateToYmd(dt);
}

/** ISO Monday (YYYY-MM-DD) of the week containing `ymd`, local time. */
export function isoMonday(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  const day = dt.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return dateToYmd(dt);
}

/** Whole weeks between two YYYY-MM-DD strings. */
export function weeksBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.floor((db.getTime() - da.getTime()) / (7 * 86400000));
}

/** "Mon Jan 23" — short weekday + month + day. */
export function formatDayDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  const dayIdx = (date.getDay() + 6) % 7; // Mon=0
  return `${SHORT_DAYS[dayIdx]} ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}

/** "Jan 23" — short month + day. */
export function formatShortDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTHS_SHORT[m! - 1]} ${d}`;
}
