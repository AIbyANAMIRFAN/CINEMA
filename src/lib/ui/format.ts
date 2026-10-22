// Client-safe display helpers. All instants are UTC; we render them in the cinema's IANA time zone.

type DateLike = Date | string | number;
const toDate = (d: DateLike) => (d instanceof Date ? d : new Date(d));

export function formatDateTime(d: DateLike, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(toDate(d));
}

export function formatTime(d: DateLike, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(toDate(d));
}

export function formatLongDate(d: DateLike, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(
    toDate(d),
  );
}

/** Short time-zone label for a given instant, e.g. "EDT" or "CST". */
export function tzLabel(d: DateLike, timeZone: string) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(toDate(d))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** YYYY-MM-DD of the instant in the given zone. */
export function localDateKey(d: DateLike, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(toDate(d));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Human label for a YYYY-MM-DD key (the key is a calendar date, so format it in UTC). */
export function dateKeyLabel(key: string, todayKey?: string) {
  if (todayKey && key === todayKey) return "Today";
  if (todayKey && key === addDaysToKey(todayKey, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(`${key}T12:00:00Z`),
  );
}

export function addDaysToKey(key: string, days: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next `count` calendar days (YYYY-MM-DD) starting today in `timeZone`. */
export function nextDays(now: Date, timeZone: string, count = 7) {
  const today = localDateKey(now, timeZone);
  return Array.from({ length: count }, (_, i) => addDaysToKey(today, i));
}

export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Convert a wall-clock time ("YYYY-MM-DDTHH:mm", as from <input type="datetime-local">) in `timeZone`
 * to a UTC Date. Returns null for malformed input.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = zoneOffsetMs(guess, timeZone);
  let t = guess - off1;
  const off2 = zoneOffsetMs(t, timeZone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** Parse a decimal money string like "12.5" or "12.50" into integer minor units without floats. */
export function parseMoneyToMinor(input: string): number | null {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Only allow same-site relative paths for post-login redirects. */
export function safeNext(next: string | string[] | undefined | null, fallback = "/") {
  const v = Array.isArray(next) ? next[0] : next;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  return v;
}

export function firstParam(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}
