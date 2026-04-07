import { describe, it, expect } from "vitest";
import {
  worldToPct,
  nearestNeighbor,
  getObjMeta,
  progressKey,
  isTaskComplete,
  encodeProfile,
  decodeProfile,
  getAllPrereqTaskIds,
} from "./utils.js";

// ─── worldToPct ──────────────────────────────────────────────────────────

describe("worldToPct", () => {
  const customsBounds = { left: 698, right: -372, top: -307, bottom: 237 };

  it("returns null for null inputs", () => {
    expect(worldToPct(null, customsBounds)).toBeNull();
    expect(worldToPct({ x: 0, y: 0, z: 0 }, null)).toBeNull();
    expect(worldToPct(null, null)).toBeNull();
  });

  it("converts center of customs correctly", () => {
    const center = { x: (698 + -372) / 2, y: 0, z: (-307 + 237) / 2 };
    const pct = worldToPct(center, customsBounds);
    expect(pct).not.toBeNull();
    expect(pct.x).toBeCloseTo(0.5, 1);
    expect(pct.y).toBeCloseTo(0.5, 1);
  });

  it("clamps values to 0.02–0.98", () => {
    const edge = { x: 698, y: 0, z: -307 };
    const pct = worldToPct(edge, customsBounds);
    expect(pct.x).toBeGreaterThanOrEqual(0.02);
    expect(pct.y).toBeGreaterThanOrEqual(0.02);
  });

  it("returns null for far out-of-bounds", () => {
    const far = { x: 9999, y: 0, z: 9999 };
    expect(worldToPct(far, customsBounds)).toBeNull();
  });

  it("handles swap flag (factory)", () => {
    const factoryBounds = { left: 67.4, right: -64.5, top: 77, bottom: -65.5, swap: true };
    const pos = { x: 0, y: 0, z: 0 };
    const pct = worldToPct(pos, factoryBounds);
    expect(pct).not.toBeNull();
    expect(pct.x).toBeGreaterThan(0);
    expect(pct.y).toBeGreaterThan(0);
  });

  it("returns null for NaN coordinates", () => {
    expect(worldToPct({ x: NaN, y: 0, z: 0 }, customsBounds)).toBeNull();
  });
});

// ─── nearestNeighbor ─────────────────────────────────────────────────────

describe("nearestNeighbor", () => {
  it("returns empty for empty input", () => {
    expect(nearestNeighbor([])).toEqual([]);
  });

  it("returns single waypoint unchanged", () => {
    const wp = [{ id: "a", pct: { x: 0.5, y: 0.5 } }];
    const result = nearestNeighbor(wp);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("orders waypoints by proximity", () => {
    const wps = [
      { id: "far", pct: { x: 0.9, y: 0.9 } },
      { id: "mid", pct: { x: 0.5, y: 0.5 } },
      { id: "close", pct: { x: 0.1, y: 0.1 } },
    ];
    const result = nearestNeighbor(wps);
    expect(result).toHaveLength(3);
    // First waypoint is whatever was first in input (index 0)
    expect(result[0].id).toBe("far");
  });

  it("handles waypoints without pct", () => {
    const wps = [
      { id: "a", pct: { x: 0.5, y: 0.5 } },
      { id: "b", pct: null },
      { id: "c", pct: { x: 0.6, y: 0.6 } },
    ];
    const result = nearestNeighbor(wps);
    expect(result).toHaveLength(3);
    // Unpositioned appended at end
    expect(result[result.length - 1].id).toBe("b");
  });

  it("handles all unpositioned waypoints", () => {
    const wps = [
      { id: "a", pct: null },
      { id: "b", pct: null },
    ];
    const result = nearestNeighbor(wps);
    expect(result).toHaveLength(2);
  });
});

// ─── getObjMeta ──────────────────────────────────────────────────────────

describe("getObjMeta", () => {
  it("handles shoot objectives", () => {
    const meta = getObjMeta({ type: "shoot", count: 5, targetNames: ["Scav"] });
    expect(meta.icon).toBe("☠");
    expect(meta.total).toBe(5);
    expect(meta.isCountable).toBe(true);
    expect(meta.summary).toContain("5×");
    expect(meta.summary).toContain("Scav");
  });

  it("handles findItem objectives", () => {
    const meta = getObjMeta({ type: "findItem", count: 3, items: [{ name: "Flash drive" }], foundInRaid: true });
    expect(meta.icon).toBe("◈");
    expect(meta.total).toBe(3);
    expect(meta.summary).toContain("Flash drive");
    expect(meta.summary).toContain("FIR");
  });

  it("handles unknown types gracefully", () => {
    const meta = getObjMeta({ type: "unknownType", description: "Do something" });
    expect(meta.icon).toBe("♦");
    expect(meta.summary).toBe("Do something");
  });

  it("handles missing fields", () => {
    const meta = getObjMeta({ type: "shoot" });
    expect(meta.total).toBe(1);
    expect(meta.summary).toContain("enemy");
  });
});

// ─── progressKey ─────────────────────────────────────────────────────────

describe("progressKey", () => {
  it("builds correct key format", () => {
    expect(progressKey("player1", "task1", "obj1")).toBe("player1-task1-obj1");
  });
});

// ─── isTaskComplete ──────────────────────────────────────────────────────

describe("isTaskComplete", () => {
  const task = {
    objectives: [
      { id: "obj1", type: "shoot", count: 5 },
      { id: "obj2", type: "visit", description: "Go there" },
    ],
  };

  it("returns false with no progress", () => {
    expect(isTaskComplete("p1", "t1", task, {})).toBe(false);
  });

  it("returns false with partial progress", () => {
    const progress = { "p1-t1-obj1": 5, "p1-t1-obj2": 0 };
    expect(isTaskComplete("p1", "t1", task, progress)).toBe(false);
  });

  it("returns true when all objectives complete", () => {
    const progress = { "p1-t1-obj1": 5, "p1-t1-obj2": 1 };
    expect(isTaskComplete("p1", "t1", task, progress)).toBe(true);
  });

  it("returns false for task with no objectives", () => {
    expect(isTaskComplete("p1", "t1", { objectives: [] }, {})).toBe(false);
  });

  it("skips optional objectives", () => {
    const taskWithOptional = {
      objectives: [
        { id: "obj1", type: "shoot", count: 1 },
        { id: "obj2", type: "visit", description: "Optional", optional: true },
      ],
    };
    const progress = { "p1-t1-obj1": 1 };
    expect(isTaskComplete("p1", "t1", taskWithOptional, progress)).toBe(true);
  });

  it("handles null task gracefully", () => {
    expect(isTaskComplete("p1", "t1", null, {})).toBe(false);
  });
});

// ─── encodeProfile / decodeProfile ───────────────────────────────────────

describe("encodeProfile / decodeProfile", () => {
  it("round-trips a profile correctly", () => {
    const profile = { name: "TestPlayer", color: "#c8a84b", tasks: [{ taskId: "t1" }], progress: { "p-t-o": 3 } };
    const code = encodeProfile(profile);
    expect(code).toMatch(/^TG2:/);
    const decoded = decodeProfile(code);
    expect(decoded).not.toBeNull();
    expect(decoded.name).toBe("TestPlayer");
    expect(decoded.color).toBe("#c8a84b");
    expect(decoded.tasks).toEqual([{ taskId: "t1" }]);
    expect(decoded.progress).toEqual({ "p-t-o": 3 });
    expect(decoded.imported).toBe(true);
  });

  it("rejects empty/null input", () => {
    expect(decodeProfile(null)).toBeNull();
    expect(decodeProfile("")).toBeNull();
  });

  it("rejects oversized input (DoS protection)", () => {
    const huge = "TG2:" + "A".repeat(60000);
    expect(decodeProfile(huge)).toBeNull();
  });

  it("rejects invalid base64", () => {
    expect(decodeProfile("TG2:not-valid-base64!!!")).toBeNull();
  });

  it("rejects profile without name", () => {
    const noName = "TG2:" + btoa(JSON.stringify({ v: 2, c: "#fff" }));
    expect(decodeProfile(noName)).toBeNull();
  });

  it("truncates long names to 30 chars", () => {
    const profile = { name: "A".repeat(50), color: "#fff", tasks: [], progress: {} };
    const decoded = decodeProfile(encodeProfile(profile));
    expect(decoded.name).toHaveLength(30);
  });

  it("defaults missing fields", () => {
    const minimal = "TG2:" + btoa(JSON.stringify({ v: 2, n: "Test" }));
    const decoded = decodeProfile(minimal);
    expect(decoded.tasks).toEqual([]);
    expect(decoded.progress).toEqual({});
    expect(decoded.color).toBe("#c8a84b");
  });
});

// ─── getAllPrereqTaskIds ─────────────────────────────────────────────────

describe("getAllPrereqTaskIds", () => {
  const tasks = [
    { id: "t1", taskRequirements: [] },
    { id: "t2", taskRequirements: [{ task: { id: "t1" }, status: ["complete"] }] },
    { id: "t3", taskRequirements: [{ task: { id: "t2" }, status: ["complete"] }] },
  ];

  it("returns empty for task with no prereqs", () => {
    expect(getAllPrereqTaskIds("t1", tasks)).toEqual([]);
  });

  it("returns direct prereqs", () => {
    expect(getAllPrereqTaskIds("t2", tasks)).toEqual(["t1"]);
  });

  it("returns transitive prereqs", () => {
    const result = getAllPrereqTaskIds("t3", tasks);
    expect(result).toContain("t1");
    expect(result).toContain("t2");
  });

  it("handles circular dependencies", () => {
    const circular = [
      { id: "a", taskRequirements: [{ task: { id: "b" }, status: ["complete"] }] },
      { id: "b", taskRequirements: [{ task: { id: "a" }, status: ["complete"] }] },
    ];
    const result = getAllPrereqTaskIds("a", circular);
    expect(result).toContain("b");
    // Should not infinite loop
  });

  it("handles missing tasks gracefully", () => {
    expect(getAllPrereqTaskIds("nonexistent", tasks)).toEqual([]);
  });
});
