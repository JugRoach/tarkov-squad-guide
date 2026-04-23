import { describe, it, expect } from "vitest";
import { buildMatchIndex, prepQuery, scoreItem, scoreItemBest, findBestMatch, tokenize } from "./fuzzyMatch.js";

// Minimal fixtures mirroring real tarkov.dev rows for the items involved in
// the scanner-mismatch bugs we've hit in the wild.
const SPLINT_ITEMS = [
  { id: "immobilizing", name: "Immobilizing splint", shortName: "Splint", width: 1, height: 1 },
  { id: "aluminum",     name: "Aluminum splint",     shortName: "Alu splint", width: 1, height: 1 },
  { id: "tigzresq",     name: "Tigzresq splint",     shortName: "Tigzresq", width: 1, height: 1 },
];

const LAMP_ITEMS = [
  { id: "uv",  name: "UV lamp",                shortName: "UV Lamp", width: 1, height: 1 },
  { id: "es",  name: "Energy-saving lamp",     shortName: "ES Lamp", width: 1, height: 1 },
];

describe("scoreItemBest — rank-penalty tiebreak", () => {
  it("prefers primary query when two items both exact-match at different ranks", () => {
    // Scenario: hovering Aluminum splint. Scanner's OCR candidates (after
    // 2-word promotion in useScanAndFetch) are:
    //   [0] "alu splint"  — the joined 2-word phrase (primary, most trusted)
    //   [1] "alu"         — single word fallback
    //   [2] "splint"      — single word fallback
    //
    // Against the Immobilizing splint item (short "Splint"), the "splint"
    // fallback hits exact-short-match at 1.15. Against the Aluminum splint
    // item (short "Alu splint"), the primary "alu splint" hits exact-short-
    // match at 1.15. Without the rank penalty these tie and the first-
    // iterated item wins arbitrarily.
    const index = buildMatchIndex(SPLINT_ITEMS);
    const queries = ["alu splint", "alu", "splint"].map((t) => prepQuery(t));

    const scores = index.map((row) => ({
      id: row.item.id,
      short: row.item.shortName,
      best: scoreItemBest(queries, row),
    }));
    scores.sort((a, b) => b.best - a.best);

    expect(scores[0].id).toBe("aluminum");
    expect(scores[0].best).toBeGreaterThan(scores[1].best);
  });

  it("does not flip winners when primary is a worse match than a later query", () => {
    // Hovering a Bandage-family item where the 2-word joined phrase happens
    // to include neighboring-tile noise. Primary "roaches bandage" scores
    // poorly against any real item; single-word "bandage" at rank 2 should
    // still win — a 0.05 rank penalty is too small to flip a 0.5-point gap.
    const items = [
      { id: "bandage", name: "Bandage", shortName: "Bandage", width: 1, height: 1 },
    ];
    const index = buildMatchIndex(items);
    const queries = ["roaches bandage", "roaches", "bandage"].map((t) => prepQuery(t));
    // bandage at rank 2 scores ~1.15, penalized by 0.10 → ~1.05. Still wins
    // over roaches-bandage at rank 0 scoring ~0.55 and roaches alone at ~0.
    expect(scoreItemBest(queries, index[0])).toBeGreaterThan(1.0);
  });

  it("keeps the existing ES Lamp fix working", () => {
    // The 2-word promotion fix from the ES Lamp bug: OCR "ES Lamp" splits
    // into ["ES", "Lamp"] + joined "ES Lamp". After promotion the primary
    // is "ES Lamp"; this should match the ES Lamp item, not UV Lamp (which
    // the single-word "Lamp" alone would match via fewer-token bias).
    const index = buildMatchIndex(LAMP_ITEMS);
    const queries = ["ES Lamp", "ES", "Lamp"].map((t) => prepQuery(t));

    const scores = index.map((row) => ({ id: row.item.id, best: scoreItemBest(queries, row) }));
    scores.sort((a, b) => b.best - a.best);
    expect(scores[0].id).toBe("es");
  });

  it("scoreItem(primary) alone matches the Aluminum splint item exactly", () => {
    // Sanity: exact shortName match returns ~1.15 (1.0 similarity + 0.15
    // substring bonus). Regression guard on the base scoring math.
    const index = buildMatchIndex(SPLINT_ITEMS);
    const alu = index.find((r) => r.item.id === "aluminum");
    const s = scoreItem(prepQuery("alu splint"), alu);
    expect(s).toBeGreaterThanOrEqual(1.1);
  });
});

describe("tooltip-verify shortName-affinity gate", () => {
  // The tooltip verify pass in useScanAndFetch.js replaced its strict
  // "same-shortName only" gate with a looser "candidate's name contains a
  // substantive short-token from the fast-scan pick" gate. These tests
  // exercise the tokenization math that gate relies on.
  it("finds substantive short tokens from the fast-scan pick", () => {
    // "Splint" → ["splint"] — a single ≥4-char token that should let
    // Aluminum splint / Tigzresq splint through the affinity gate.
    expect(tokenize("Splint").filter((t) => t.length >= 4)).toEqual(["splint"]);
    // "Alu splint" → ["splint"] — "alu" is <4 chars so it's dropped.
    // Still produces a substantive token, so the gate has something to match on.
    expect(tokenize("Alu splint").filter((t) => t.length >= 4)).toEqual(["splint"]);
    // "UV Lamp" → ["lamp"] — similarly discards the 2-char "UV".
    expect(tokenize("UV Lamp").filter((t) => t.length >= 4)).toEqual(["lamp"]);
    // Edge case: short name with ONLY short tokens — no substantive tokens
    // available, so gate falls back to strict same-shortName check.
    expect(tokenize("UV").filter((t) => t.length >= 4)).toEqual([]);
  });

  it("lets splint-family items share affinity across shortNames", () => {
    const index = buildMatchIndex(SPLINT_ITEMS);
    const pickShortTokens = tokenize("Splint").filter((t) => t.length >= 4);
    // Immobilizing, Aluminum, and Tigzresq splints all contain "splint" in
    // their NAME tokens, so the loosened gate allows all three even though
    // their shortNames differ from the fast-scan pick's "Splint".
    const allowed = index.filter((row) =>
      row.item.shortName === "Splint" ||
      pickShortTokens.some((t) => row.tokens.includes(t)),
    );
    expect(allowed.map((r) => r.item.id).sort()).toEqual(["aluminum", "immobilizing", "tigzresq"]);
  });

  it("blocks unrelated leakage through the affinity gate", () => {
    // Hypothetical adjacency leak: fast-scan picked Bandage, but tooltip
    // region accidentally captured text from a neighboring Splint tile.
    // The gate should NOT let Splint items verify when fast-scan's short
    // tokens don't appear in their name tokens.
    const pickShortTokens = tokenize("Bandage").filter((t) => t.length >= 4);
    // "Bandage" → ["bandage"]. None of the splint items' name tokens
    // include "bandage", so all three should fail the cross-shortName gate.
    const index = buildMatchIndex(SPLINT_ITEMS);
    const allowedCross = index.filter((row) =>
      row.item.shortName !== "Bandage" &&
      pickShortTokens.some((t) => row.tokens.includes(t)),
    );
    expect(allowedCross).toHaveLength(0);
  });
});

describe("findBestMatch — regression cases", () => {
  it("matches 'alu splint' to Aluminum splint, not Immobilizing splint", () => {
    const index = buildMatchIndex(SPLINT_ITEMS);
    const m = findBestMatch("alu splint", index);
    expect(m?.item?.id).toBe("aluminum");
  });

  it("still matches 'splint' alone to Immobilizing splint (shortest exact match)", () => {
    // When the user's OCR only captures the single word "splint", the
    // generic Splint (Immobilizing) should still win — we're not trying to
    // force the longer name when the query itself is short.
    const index = buildMatchIndex(SPLINT_ITEMS);
    const m = findBestMatch("splint", index);
    expect(m?.item?.id).toBe("immobilizing");
  });
});
