import { describe, it, expect } from "vitest";
import { optimizeBuild } from "./buildOptimizer.js";

const mod = (id, ergo, conflicts = [], subSlots = null) => ({
  id,
  properties: { ergonomics: ergo, ...(subSlots ? { slots: subSlots } : {}) },
  conflictingItems: conflicts.map((cId) => ({ id: cId })),
});

const slot = (nameId, items, opts = {}) => ({
  nameId,
  required: !!opts.required,
  filters: { allowedItems: items },
});

const weapon = (slots) => ({ properties: { slots } });

describe("optimizeBuild (branch-and-bound)", () => {
  it("picks the highest-scoring mod per slot when there are no conflicts", () => {
    const w = weapon([
      slot("mod_stock", [mod("stock_a", 10), mod("stock_b", 20)]),
      slot("mod_grip", [mod("grip_a", 5), mod("grip_b", 15)]),
    ]);
    const result = optimizeBuild(w, "ergo");
    expect(result).toEqual({ mod_stock: "stock_b", mod_grip: "grip_b" });
  });

  it("finds the globally optimal combo when top-level slots cross-conflict", () => {
    // Greedy (UB-sorted): picks stock_a1 (20), blocks grip_b1 → grip_b2 (2) = 22.
    // Optimal: stock_a2 (18) + grip_b1 (19) = 37.
    const w = weapon([
      slot("mod_stock", [mod("stock_a1", 20, ["grip_b1"]), mod("stock_a2", 18)]),
      slot("mod_grip", [mod("grip_b1", 19), mod("grip_b2", 2)]),
    ]);
    const result = optimizeBuild(w, "ergo");
    expect(result).toEqual({ mod_stock: "stock_a2", mod_grip: "grip_b1" });
  });

  it("finds the globally optimal combo when sibling sub-slots conflict", () => {
    // Two sub-slots under one parent. Greedy-natural-order picks X first
    // (ergo 10), blocks Y, falls back to Y2 (2) → subtree total 12.
    // Optimal: X2 (9) + Y (11) → subtree total 20.
    const w = weapon([
      slot(
        "mod_reciever",
        [
          mod("rec_a", 5, [], [
            slot("mod_tac_left", [mod("X", 10, ["Y"]), mod("X2", 9)]),
            slot("mod_tac_right", [mod("Y", 11), mod("Y2", 2)]),
          ]),
        ],
        { required: true }
      ),
    ]);
    const result = optimizeBuild(w, "ergo");
    expect(result.mod_reciever).toBe("rec_a");
    expect(result["mod_reciever.mod_tac_left"]).toBe("X2");
    expect(result["mod_reciever.mod_tac_right"]).toBe("Y");
  });

  it("preserves user-picked scope/sight/magazine slots from currentMods", () => {
    const w = weapon([
      slot("mod_stock", [mod("stock_a", 10)]),
      slot("mod_magazine", [mod("mag_small", 5), mod("mag_big", 3)]),
    ]);
    const currentMods = { mod_magazine: "mag_small" };
    const result = optimizeBuild(w, "ergo", { currentMods });
    expect(result.mod_stock).toBe("stock_a");
    expect(result.mod_magazine).toBe("mag_small");
  });

  it("respects isAvailable filter", () => {
    const w = weapon([
      slot("mod_stock", [mod("stock_good", 100), mod("stock_ok", 50)]),
    ]);
    const isAvailable = (item) => item.id !== "stock_good";
    const result = optimizeBuild(w, "ergo", { isAvailable });
    expect(result.mod_stock).toBe("stock_ok");
  });

  it("leaves optional slots empty when no item scores above zero", () => {
    const w = weapon([
      slot("mod_stock", [mod("stock_neg", -5), mod("stock_neg2", -2)]),
    ]);
    const result = optimizeBuild(w, "ergo");
    expect(result.mod_stock).toBeUndefined();
  });

  it("returns empty mods for a weapon with no slots", () => {
    const w = weapon([]);
    expect(optimizeBuild(w, "ergo")).toEqual({});
  });
});
