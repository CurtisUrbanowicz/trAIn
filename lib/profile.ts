/**
 * athlete_profile: what the athlete has said — goals, injuries, how they want
 * to be coached and to train — under four fixed headings. Append-only; the
 * newest row is current. Written by chat (observe-surface-confirm) and by the
 * patterns pass's weekly review, both through update_athlete_profile, which
 * checks every write against the previous version with checkProfileWrite.
 */

export const PROFILE_HEADINGS = [
  "Goals",
  "Injury history",
  "Coaching preferences",
  "Training preferences",
] as const;

export type ProfileHeading = (typeof PROFILE_HEADINGS)[number];

// A heading at the start of a line, optionally markdown-prefixed, optionally
// followed by a colon and inline content ("Goals:" or "## Goals" or
// "Goals: half marathon …")
const HEADING_RE = new RegExp(
  `^\\s*(?:#+\\s*)?(${PROFILE_HEADINGS.join("|")})\\s*(?::|$)\\s*(.*)$`,
  "i"
);

function canonicalHeading(raw: string): ProfileHeading {
  return PROFILE_HEADINGS.find(
    (h) => h.toLowerCase() === raw.toLowerCase()
  )!;
}

/** Each heading present → its non-empty content lines, in order. */
export function parseProfileSections(
  content: string
): Map<ProfileHeading, string[]> {
  const sections = new Map<ProfileHeading, string[]>();
  let current: ProfileHeading | null = null;
  for (const line of content.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line);
    if (m) {
      current = canonicalHeading(m[1]!);
      if (!sections.has(current)) sections.set(current, []);
      if (m[2]!.trim()) sections.get(current)!.push(m[2]!.trim());
      continue;
    }
    if (current && line.trim()) sections.get(current)!.push(line.trim());
  }
  return sections;
}

// Line identity for the injury check: bullets, case, spacing and a trailing
// full stop don't count as a change
function normaliseLine(line: string): string {
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Null when the new profile may be written, otherwise the reason it may not:
 * a missing heading, or an Injury history line from the previous version
 * that the new one drops. Appending to injury history is fine.
 */
export function checkProfileWrite(
  previous: string | null,
  next: string
): string | null {
  const nextSections = parseProfileSections(next);
  const missing = PROFILE_HEADINGS.filter((h) => !nextSections.has(h));
  if (missing.length > 0) {
    return `the profile must have all four headings (${PROFILE_HEADINGS.map((h) => `${h}:`).join(", ")}), each on its own line. Missing: ${missing.join(", ")}.`;
  }

  if (previous) {
    const oldInjury = parseProfileSections(previous).get("Injury history") ?? [];
    const newInjury = new Set(
      (nextSections.get("Injury history") ?? []).map(normaliseLine)
    );
    const dropped = oldInjury.filter((l) => !newInjury.has(normaliseLine(l)));
    if (dropped.length > 0) {
      return `injury history is never removed. Keep these lines under Injury history exactly as they were: ${dropped.map((l) => `"${l}"`).join("; ")}.`;
    }
  }
  return null;
}

/** Headings whose content differs between two versions, in heading order. */
export function changedProfileHeadings(
  previous: string,
  next: string
): ProfileHeading[] {
  const a = parseProfileSections(previous);
  const b = parseProfileSections(next);
  const key = (lines: string[] | undefined) =>
    (lines ?? []).map(normaliseLine).join("\n");
  return PROFILE_HEADINGS.filter((h) => key(a.get(h)) !== key(b.get(h)));
}
