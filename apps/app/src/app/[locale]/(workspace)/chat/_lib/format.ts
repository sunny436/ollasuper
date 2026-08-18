/** Mirrors the helper in files/page.tsx so sizes read the same across the app. */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Groups threads the way the sidebar displays them. */
export function timeBucket(ts: number): string {
  const now = new Date();
  const then = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - 86_400_000) return "Yesterday";
  if (ts >= startOfToday - 7 * 86_400_000) return "Previous 7 days";
  if (ts >= startOfToday - 30 * 86_400_000) return "Previous 30 days";
  return then.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
