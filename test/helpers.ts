import { join, resolve } from "node:path";
import { loadInventory, loadStore } from "../src/store.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const EX = join(ROOT, "examples");
export const store = loadStore(join(EX, "store.json"));
export const inventory = loadInventory(join(EX, "inventory.json"));
export const crossover = inventory.find((v) => v.stock === "U4821")!;
