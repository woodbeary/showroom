import { readFileSync } from "node:fs";
import { minutesOf, type QuietHours } from "./clock.ts";

export interface Store {
  name: string;
  timeZone: string;
  quietHours: QuietHours;
  driveHours: { open: string; close: string; closedDays: string[] };
  tone: { maxChars: number; maxExclamations: number; pressurePhrases: string[] };
}

export type VehicleStatus = "available" | "on_hold" | "sold";

export interface Vehicle {
  stock: string;
  title: string;
  miles: number;
  price: number;
  status: VehicleStatus;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadStore(path: string): Store {
  const store = readJson(path) as Store;
  new Intl.DateTimeFormat("en-US", { timeZone: store.timeZone });
  for (const t of [store.quietHours.start, store.quietHours.end, store.driveHours.open, store.driveHours.close]) {
    minutesOf(t);
  }
  return store;
}

export function loadInventory(path: string): Vehicle[] {
  const rows = readJson(path);
  if (!Array.isArray(rows)) throw new Error(`${path}: expected an array of vehicles`);
  return rows.map((v: Vehicle) => {
    if (typeof v.stock !== "string" || !Number.isFinite(v.price) || !["available", "on_hold", "sold"].includes(v.status)) {
      throw new Error(`${path}: bad vehicle ${JSON.stringify(v)}`);
    }
    return v;
  });
}

export function lookupVehicle(inventory: readonly Vehicle[], stock: string | undefined): Vehicle | null {
  return inventory.find((v) => v.stock === stock) ?? null;
}
