export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${field} must be an ISO 8601 time with Z or an offset, got ${JSON.stringify(value)}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} is not a valid time: ${value}`);
  return date;
}

export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const year = parts.year ?? 0;
  const month = parts.month ?? 1;
  const day = parts.day ?? 1;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "sunday";
  return { year, month, day, hour: parts.hour ?? 0, minute: parts.minute ?? 0, weekday };
}

export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const seen = localTime(new Date(guess), timeZone);
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += wall - seenWall;
  }
  return new Date(guess);
}

export function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`expected HH:MM, got ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface QuietHours {
  start: string;
  end: string;
}

export function inQuietHours(instant: Date, quiet: QuietHours, timeZone: string): boolean {
  const t = localTime(instant, timeZone);
  const now = t.hour * 60 + t.minute;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start > end ? now >= start || now < end : now >= start && now < end;
}

export function earliestSend(decidedAt: Date, quiet: QuietHours, timeZone: string): Date {
  if (!inQuietHours(decidedAt, quiet, timeZone)) return decidedAt;
  const t = localTime(decidedAt, timeZone);
  const end = minutesOf(quiet.end);
  const sameDay = t.hour * 60 + t.minute < end;
  const base = new Date(Date.UTC(t.year, t.month - 1, t.day + (sameDay ? 0 : 1)));
  return zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), Math.floor(end / 60), end % 60, timeZone);
}

export function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const x = localTime(a, timeZone);
  const y = localTime(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

export function clockText(t: LocalTime): string {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}:${String(t.minute).padStart(2, "0")} ${t.hour < 12 ? "am" : "pm"}`;
}

export function describe(instant: Date, timeZone: string): string {
  const t = localTime(instant, timeZone);
  const day = t.weekday.slice(0, 3);
  const date = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  return `${day[0]?.toUpperCase()}${day.slice(1)} ${date} ${clockText(t)}`;
}
