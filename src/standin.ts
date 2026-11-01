import { clockText, localTime, minutesOf, zonedInstant } from "./clock.ts";
import { readInbound } from "./intent.ts";
import type { Model, ModelRequest, Proposal } from "./model.ts";

const CANDIDATE_TIMES = ["10:00", "12:30", "15:00", "17:30", "18:15"];
const LEAD_TIME_MS = 2 * 60 * 60 * 1000;

const capital = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

export function nextSlots(request: Pick<ModelRequest, "sendAt" | "store">, count = 2): string[] {
  const { timeZone, driveHours } = request.store;
  const earliest = Date.parse(request.sendAt) + LEAD_TIME_MS;
  const start = localTime(new Date(request.sendAt), timeZone);
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const picks: Date[] = [];
    for (const hhmm of CANDIDATE_TIMES) {
      const m = minutesOf(hhmm);
      if (m < minutesOf(driveHours.open) || m >= minutesOf(driveHours.close)) continue;
      const at = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(m / 60), m % 60, timeZone);
      if (driveHours.closedDays.includes(localTime(at, timeZone).weekday)) break;
      if (at.getTime() >= earliest) picks.push(at);
    }
    if (picks.length >= count) return picks.slice(-count).map((d) => d.toISOString());
  }
  return [];
}

function spoken(iso: string, timeZone: string): { day: string; time: string } {
  const t = localTime(new Date(iso), timeZone);
  return { day: capital(t.weekday), time: clockText(t) };
}

function acceptedSlot(text: string, request: ModelRequest): string | undefined {
  const named = [...text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((m) => `${Number(m[1])}:${m[2]}`);
  return request.offeredSlots.find((s) => {
    const t = localTime(new Date(s), request.store.timeZone);
    return named.includes(`${t.hour % 12 === 0 ? 12 : t.hour % 12}:${String(t.minute).padStart(2, "0")}`);
  });
}

export function routineModel(): Model {
  return {
    name: "routine-standin",
    async propose(request): Promise<Proposal> {
      const last = request.thread[request.thread.length - 1]?.text ?? "";
      const reading = readInbound(last);
      const tz = request.store.timeZone;

      if (request.state === "drive_offered") {
        const slot = acceptedSlot(last, request);
        if (slot) {
          const s = spoken(slot, tz);
          return { next: "booked", slot, draft: `You're set for ${s.day} at ${s.time}. Ask for the front desk when you get here.` };
        }
      }
      if (reading.kind === "ask") {
        const v = request.vehicle;
        if (!v) return { next: "handed_off", draft: null, desk: "salesperson", reason: "no_vehicle_on_file" };
        if (v.status !== "available") return { next: "handed_off", draft: null, desk: "salesperson", reason: `vehicle_${v.status}` };
        const slots = nextSlots(request);
        const [a, b] = slots.map((s) => spoken(s, tz));
        if (!a || !b) return { next: "handed_off", draft: null, desk: "salesperson", reason: "no_open_slots" };
        return {
          next: "drive_offered",
          slots,
          draft: `It's here and ready to drive. I can have it up front ${a.day} at ${a.time} or ${b.time}. Which works better?`,
        };
      }
      if (reading.kind === "decline") {
        return { next: "closed", draft: "Thanks for letting me know. If anything changes, text this number anytime." };
      }
      if (reading.kind === "not_yet") {
        return { next: request.state, draft: "No rush. Text this number whenever you're ready." };
      }
      return { next: request.state, draft: null };
    },
  };
}
