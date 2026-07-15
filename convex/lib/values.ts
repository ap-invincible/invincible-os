export const DEFAULT_REPOS = ["invincible/onboarding", "invincible/engineering-handbook"];
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function monthFromDate(value: string) {
  const match = value.match(/^(\d{4}-\d{2})/);
  return match?.[1] ?? new Date().toISOString().slice(0, 7);
}

export function expenseReason(flags: string[]) {
  return flags.length ? `Flagged: ${flags.join(", ").replaceAll("_", " ")}.` : "Cleared: no duplicate, missing PO, or category-spend anomaly found.";
}
