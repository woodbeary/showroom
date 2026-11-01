export const STATES = [
  "new",
  "engaged",
  "qualified",
  "vehicle_confirmed",
  "drive_offered",
  "booked",
  "confirmed",
  "handed_off",
  "opted_out",
  "closed",
] as const;

export type State = (typeof STATES)[number];

const EXITS = ["handed_off", "opted_out", "closed"] as const;

export const MOVES: Readonly<Record<State, readonly State[]>> = {
  new: ["engaged", ...EXITS],
  engaged: ["qualified", "vehicle_confirmed", "drive_offered", ...EXITS],
  qualified: ["vehicle_confirmed", "drive_offered", ...EXITS],
  vehicle_confirmed: ["drive_offered", ...EXITS],
  drive_offered: ["booked", ...EXITS],
  booked: ["confirmed", "drive_offered", ...EXITS],
  confirmed: ["drive_offered", ...EXITS],
  handed_off: [],
  opted_out: [],
  closed: ["engaged"],
};

export const AGENT_MAY_ACT: ReadonlySet<State> = new Set(
  STATES.filter((s) => s !== "handed_off" && s !== "opted_out"),
);

export function isState(value: unknown): value is State {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

export function canMove(from: State, to: State): boolean {
  if (from === to) return AGENT_MAY_ACT.has(from) && from !== "closed" && from !== "new";
  return MOVES[from].includes(to);
}

export function onInbound(state: State): State[] {
  if (state === "new" || state === "closed") return [state, "engaged"];
  return [state];
}
