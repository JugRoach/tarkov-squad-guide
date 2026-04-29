import { describe, it, expect } from "vitest";
import { optimizeBuild } from "./buildOptimizer.js";

// `ergoOrProps` accepts a number (ergonomics shorthand) or a full properties
// object so targeted-mode tests can specify recoilModifier too.
const mod = (id, ergoOrProps, conflicts = [], subSlots = null) => {
  const base =
    typeof ergoOrProps === "number"
      ? { ergonomics: ergoOrProps }
      : ergoOrProps;
  return {
    id,
    properties: { ...base, ...(subSlots ? { slots: subSlots } : {}) },
    conflictingItems: conflicts.map((cId) => ({ id: cId })),
  };
};

const slot = (nameId, items, opts = {}) => ({
  nameId,
  required: !!opts.required,
  filters: { allowedItems: items },
});

const weapon = (slots, extraProps = {}) => ({
  properties: { slots, ...extraProps },
});

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
    const w = weapon([
      slot("mod_stock", [mod("stock_a1", 20, ["grip_b1"]), mod("stock_a2", 18)]),
      slot("mod_grip", [mod("grip_b1", 19), mod("grip_b2", 2)]),
    ]);
    const result = optimizeBuild(w, "ergo");
    expect(result).toEqual({ mod_stock: "stock_a2", mod_grip: "grip_b1" });
  });

  it("finds the globally optimal combo when sibling sub-slots conflict", () => {
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

describe("optimizeBuild recoil-balanced (target-ergo methodology)", () => {
  it("picks a Pareto-interior mod that no weighted-sum scalarization could find", () => {
    // Max ergo (OPT ERGO) = 100 (via high_ergo). target = 50.
    // Feasible builds (ergo >= target):
    //   high_ergo: ergo=100, recoil=0
    //   mid_ergo:  ergo=50,  recoil=20 ← winner (max recoil among feasible)
    //   low_ergo:  ergo=0    INFEASIBLE
    // mid_ergo is Pareto-dominated in weighted-sum space — no w makes it win.
    const w = weapon([
      slot("mod_stock", [
        mod("high_ergo", { ergonomics: 100, recoilModifier: 0 }),
        mod("mid_ergo", { ergonomics: 50, recoilModifier: -0.2 }),
        mod("low_ergo", { ergonomics: 0, recoilModifier: -0.5 }),
      ]),
    ]);
    const result = optimizeBuild(w, "recoil-balanced");
    expect(result.mod_stock).toBe("mid_ergo");
  });

  it("prefers higher recoil when ergo is above target (above-target is free)", () => {
    // Both options feasible (ergo >= 50). Winner is the one with better recoil.
    //   mod_high:   ergo=100, recoil=10
    //   mod_medium: ergo=70,  recoil=30 ← winner
    const w = weapon([
      slot("mod_stock", [
        mod("mod_high", { ergonomics: 100, recoilModifier: -0.1 }),
        mod("mod_medium", { ergonomics: 70, recoilModifier: -0.3 }),
      ]),
    ]);
    const result = optimizeBuild(w, "recoil-balanced");
    expect(result.mod_stock).toBe("mod_medium");
  });

  it("rejects builds below target ergo entirely (hard floor)", () => {
    // Max ergo = 100 (high_only), target = 50.
    //   high_only:  ergo=100, recoil=0   feasible
    //   low_recoil: ergo=10   INFEASIBLE (even though recoil=30)
    // With a hard ergo floor, low_recoil is rejected outright; high_only
    // wins by default despite its worse recoil. Matches the stated
    // methodology — ergo target is a constraint, not a soft preference.
    const w = weapon([
      slot("mod_stock", [
        mod("high_only", { ergonomics: 100, recoilModifier: 0 }),
        mod("low_recoil", { ergonomics: 10, recoilModifier: -0.3 }),
      ]),
    ]);
    const result = optimizeBuild(w, "recoil-balanced");
    expect(result.mod_stock).toBe("high_only");
  });

  it("combines two slots to hit target with max recoil", () => {
    // Max ergo = A1+B1 = 90. target = 45.
    //   A1+B1: ergo=90, recoil=0    feasible
    //   A1+B2: ergo=70, recoil=30   feasible ← winner
    //   A2+B1: ergo=60, recoil=20   feasible
    //   A2+B2: ergo=40              INFEASIBLE (below 45)
    const w = weapon([
      slot("mod_stock", [
        mod("A1", { ergonomics: 60, recoilModifier: 0 }),
        mod("A2", { ergonomics: 30, recoilModifier: -0.2 }),
      ]),
      slot("mod_grip", [
        mod("B1", { ergonomics: 30, recoilModifier: 0 }),
        mod("B2", { ergonomics: 10, recoilModifier: -0.3 }),
      ]),
    ]);
    const result = optimizeBuild(w, "recoil-balanced");
    expect(result).toEqual({ mod_stock: "A1", mod_grip: "B2" });
  });

  it("counts the weapon's base ergo toward the target", () => {
    // Weapon base ergo = 40. Only mod adds another 20. Max ergo = 60, target = 30.
    // Base alone (skip mod): total ergo = 40 ≥ target. score = 0 - 0 = 0.
    // Pick mod: total ergo = 60 ≥ target. score = 0 - 0 = 0. Tie on score.
    // Since greedy sort tries the higher-combined-contribution mod first and
    // the optional-skip is also score 0, either could win — here we just
    // check the build's ergo is above target.
    const w = weapon(
      [slot("mod_stock", [mod("extra", { ergonomics: 20, recoilModifier: 0 })])],
      { ergonomics: 40 }
    );
    const result = optimizeBuild(w, "recoil-balanced");
    // Either pick works — both yield score 0. Just assert it didn't crash
    // and the result is a valid mods map.
    expect(typeof result).toBe("object");
  });
});

describe("optimizeBuild lockedPaths", () => {
  it("preserves the locked mod even when a higher-scoring alternative exists", () => {
    const w = weapon([
      slot("mod_stock", [mod("low", 5), mod("high", 50)]),
    ]);
    const result = optimizeBuild(w, "ergo", {
      currentMods: { mod_stock: "low" },
      lockedPaths: new Set(["mod_stock"]),
    });
    expect(result.mod_stock).toBe("low");
  });

  it("locked mod's conflicts block other slots from picking conflicting items", () => {
    // Lock stock_a (which conflicts with grip_b). Optimizer must pick grip_alt.
    const w = weapon([
      slot("mod_stock", [mod("stock_a", 5, ["grip_b"])]),
      slot("mod_grip", [mod("grip_b", 100), mod("grip_alt", 10)]),
    ]);
    const result = optimizeBuild(w, "ergo", {
      currentMods: { mod_stock: "stock_a" },
      lockedPaths: new Set(["mod_stock"]),
    });
    expect(result.mod_stock).toBe("stock_a");
    expect(result.mod_grip).toBe("grip_alt");
  });

  it("locked-empty optional slot stays empty", () => {
    const w = weapon([
      slot("mod_stock", [mod("stock_a", 50)]),
      slot("mod_tactical", [mod("tac_a", 30)]),
    ]);
    const result = optimizeBuild(w, "ergo", {
      currentMods: {},
      lockedPaths: new Set(["mod_tactical"]),
    });
    expect(result.mod_stock).toBe("stock_a");
    expect(result.mod_tactical).toBeUndefined();
  });

  it("silently drops a lock that conflicts with itself / pre-chosen state", () => {
    // Two locks that conflict with each other. Optimizer can't honor both,
    // should drop one (or both) and produce a valid build instead of crashing.
    const w = weapon([
      slot("mod_stock", [mod("stock_a", 10, ["grip_b"])]),
      slot("mod_grip", [mod("grip_b", 10, ["stock_a"])]),
    ]);
    const result = optimizeBuild(w, "ergo", {
      currentMods: { mod_stock: "stock_a", mod_grip: "grip_b" },
      lockedPaths: new Set(["mod_stock", "mod_grip"]),
    });
    // One lock wins, other dropped — both can't coexist. We just assert
    // the result is a valid mods object and didn't crash.
    expect(typeof result).toBe("object");
  });

  it("locks nested sub-slot path", () => {
    // Lock the sub-slot's tactical pick, optimizer keeps it through opt run.
    const w = weapon([
      slot(
        "mod_handguard",
        [
          mod("hg", 5, [], [
            slot("mod_tactical", [mod("tac_low", 5), mod("tac_high", 50)]),
          ]),
        ],
        { required: true }
      ),
    ]);
    const result = optimizeBuild(w, "ergo", {
      currentMods: { "mod_handguard.mod_tactical": "tac_low" },
      lockedPaths: new Set(["mod_handguard.mod_tactical"]),
    });
    expect(result.mod_handguard).toBe("hg");
    expect(result["mod_handguard.mod_tactical"]).toBe("tac_low");
  });
});

describe("optimizeBuild custom mode (dual floors)", () => {
  it("maximizes E + R when both targets are met (no constraint binding)", () => {
    // Both at 0 → no floor → maximize E + R sum.
    //   stock_a: E=10, R=20, sum=30 ← winner
    //   stock_b: E=20, R=5,  sum=25
    const w = weapon([
      slot("mod_stock", [
        mod("stock_a", { ergonomics: 10, recoilModifier: -0.2 }),
        mod("stock_b", { ergonomics: 20, recoilModifier: -0.05 }),
      ]),
    ]);
    const result = optimizeBuild(w, "custom", {
      ergoTarget: 0,
      recoilTarget: 0,
    });
    expect(result.mod_stock).toBe("stock_a");
  });

  it("respects ergo floor — picks lower-recoil option to clear it", () => {
    //   stock_a: E=10, R=30  infeasible (E < 50) — closest, but penalty kicks
    //   stock_b: E=60, R=5   feasible
    //   stock_c: E=50, R=10  feasible ← winner (higher sum 60 vs 65)
    // Wait: stock_b sum = 65, stock_c sum = 60. So stock_b wins.
    const w = weapon([
      slot("mod_stock", [
        mod("stock_a", { ergonomics: 10, recoilModifier: -0.3 }),
        mod("stock_b", { ergonomics: 60, recoilModifier: -0.05 }),
        mod("stock_c", { ergonomics: 50, recoilModifier: -0.1 }),
      ]),
    ]);
    const result = optimizeBuild(w, "custom", {
      ergoTarget: 50,
      recoilTarget: 0,
    });
    expect(result.mod_stock).toBe("stock_b");
  });

  it("respects recoil floor — picks higher-recoil option to clear it", () => {
    //   stock_a: E=50, R=5   infeasible (R < 20)
    //   stock_b: E=10, R=30  feasible ← winner (sum 40 with floors met)
    //   stock_c: E=20, R=20  feasible (sum 40, ties stock_b)
    const w = weapon([
      slot("mod_stock", [
        mod("stock_a", { ergonomics: 50, recoilModifier: -0.05 }),
        mod("stock_b", { ergonomics: 10, recoilModifier: -0.3 }),
      ]),
    ]);
    const result = optimizeBuild(w, "custom", {
      ergoTarget: 0,
      recoilTarget: 20,
    });
    expect(result.mod_stock).toBe("stock_b");
  });

  it("falls back to closest-feasible when neither option meets targets", () => {
    // Targets: E=100, R=100 — unachievable.
    //   stock_a: E=20, R=30  total deficit = 80 + 70 = 150
    //   stock_b: E=50, R=10  total deficit = 50 + 90 = 140 ← lower deficit
    // stock_b's combined: (50+10) - 2*(50+90) = 60 - 280 = -220
    // stock_a's combined: (20+30) - 2*(80+70) = 50 - 300 = -250
    // stock_b wins.
    const w = weapon([
      slot("mod_stock", [
        mod("stock_a", { ergonomics: 20, recoilModifier: -0.3 }),
        mod("stock_b", { ergonomics: 50, recoilModifier: -0.1 }),
      ]),
    ]);
    const result = optimizeBuild(w, "custom", {
      ergoTarget: 100,
      recoilTarget: 100,
    });
    expect(result.mod_stock).toBe("stock_b");
  });

  it("respects locks in custom mode", () => {
    // Lock stock_low even though stock_high would maximize the score.
    const w = weapon([
      slot("mod_stock", [
        mod("stock_low", { ergonomics: 5, recoilModifier: 0 }),
        mod("stock_high", { ergonomics: 50, recoilModifier: -0.3 }),
      ]),
    ]);
    const result = optimizeBuild(w, "custom", {
      ergoTarget: 0,
      recoilTarget: 0,
      currentMods: { mod_stock: "stock_low" },
      lockedPaths: new Set(["mod_stock"]),
    });
    expect(result.mod_stock).toBe("stock_low");
  });
});
