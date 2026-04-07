/** Convert snake_case session type to Title Case. e.g. "upper_strength" → "Upper Strength" */
export function formatSessionType(raw: string): string {
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
