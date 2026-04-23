import { describe, it, expect } from "vitest";
import {
  mergeTaskLines,
  isAmbiguousPartSiblings,
  expandSeriesAlternates,
  partPrefix,
  PART_FRAGMENT_RE,
} from "./taskScanUtils.js";

describe("mergeTaskLines", () => {
  it("merges 'Test Drive' + '- Part 3' into one line", () => {
    const lines = [
      "The Bunker - Part 1",
      "The Art of Explosion",
      "Test Drive",
      "- Part 3",
      "Shaking Up the Teller",
    ];
    expect(mergeTaskLines(lines)).toEqual([
      "The Bunker - Part 1",
      "The Art of Explosion",
      "Test Drive - Part 3",
      "Shaking Up the Teller",
    ]);
  });

  it("leaves single-line Part-N task names alone", () => {
    expect(mergeTaskLines(["The Bunker - Part 1", "The Art of Explosion"])).toEqual([
      "The Bunker - Part 1",
      "The Art of Explosion",
    ]);
  });

  it("accepts en-dash variant '– Part N'", () => {
    expect(mergeTaskLines(["Test Drive", "– Part 3"])).toEqual(["Test Drive – Part 3"]);
  });

  it("handles multiple split rows in the same list", () => {
    expect(mergeTaskLines([
      "Test Drive",
      "- Part 3",
      "Gunsmith",
      "- Part 17",
    ])).toEqual([
      "Test Drive - Part 3",
      "Gunsmith - Part 17",
    ]);
  });

  it("drops empty strings and merges across them", () => {
    expect(mergeTaskLines(["", "Test Drive", "", "- Part 3", ""])).toEqual([
      "Test Drive - Part 3",
    ]);
  });

  it("merges across interleaved column headers when curr ends with a dash", () => {
    // The Bunker regression #2: OCR produced "The Bunker -" / "Task" / "Part 1"
    // (the Task column header landed between the truncated task name and its
    // Part continuation). Lookahead merge with chrome-skip reconstructs it.
    expect(mergeTaskLines(["The Bunker -", "Task", "Part 1", "The Art of Explosion"])).toEqual([
      "The Bunker - Part 1",
      "The Art of Explosion",
    ]);
  });

  it("does NOT lookahead when curr has no trailing dash (prevents wild merges)", () => {
    // "Debut" is a 1-token task. Even with chrome-skip lookahead available,
    // "Debut" must not swallow a distant Part-N fragment — only the
    // trailing-dash signal triggers the lookahead. (The intervening "Task"
    // chrome line will still absorb "Part 1" via immediate-adjacency into
    // "Task Part 1", which is harmless because fuzzy match rejects it.)
    const result = mergeTaskLines(["Debut", "Task", "Part 1"]);
    expect(result).toContain("Debut");
    expect(result.some((l) => /debut\s+part\s+1/i.test(l))).toBe(false);
  });

  it("stops lookahead at non-chrome content", () => {
    // If a real task line appears between curr and a Part-N fragment, we
    // don't skip over it. (Otherwise "Test Drive -" could swallow
    // "Shaking Up the Teller" + "- Part 2" from another row.)
    expect(mergeTaskLines([
      "Test Drive -",
      "Shaking Up the Teller",
      "- Part 2",
    ])).toEqual([
      "Test Drive -",
      "Shaking Up the Teller - Part 2",
    ]);
  });

  it("merges bare 'Part N' fragments (OCR dropped the dash)", () => {
    // The Bunker regression: OCR split "The Bunker - Part 1" into
    // "The Bunker" + "Part 1" without the dash on some runs.
    expect(mergeTaskLines(["The Bunker", "Part 1"])).toEqual(["The Bunker Part 1"]);
    expect(mergeTaskLines(["Test Drive", "Part 3"])).toEqual(["Test Drive Part 3"]);
  });

  it("does not merge when curr already ends with Part N", () => {
    // Defensive: prevents 'Colleagues - Part 2' + '- Part 3' (if a sibling
    // dash fragment is accidentally adjacent) from merging into gibberish.
    expect(mergeTaskLines(["Colleagues - Part 2", "- Part 3"])).toEqual([
      "Colleagues - Part 2",
      "- Part 3",
    ]);
  });
});

describe("PART_FRAGMENT_RE", () => {
  it("matches continuation fragments in both dashed and bare forms", () => {
    expect(PART_FRAGMENT_RE.test("- Part 3")).toBe(true);
    expect(PART_FRAGMENT_RE.test("– Part 3")).toBe(true);
    expect(PART_FRAGMENT_RE.test("Part 1")).toBe(true);
    expect(PART_FRAGMENT_RE.test("part 17")).toBe(true);
  });
  it("does not match full task names with a Part suffix", () => {
    // Whole task names end with Part N, but they have a prefix — shouldn't
    // get dropped as a fragment.
    expect(PART_FRAGMENT_RE.test("The Bunker - Part 1")).toBe(false);
    expect(PART_FRAGMENT_RE.test("Gunsmith – Part 17")).toBe(false);
  });
  it("does not match lines that continue past the Part number", () => {
    expect(PART_FRAGMENT_RE.test("Part 1 Any location")).toBe(false);
  });
  it("accepts OCR digit-as-letter misreads (Part S ≈ Part 5, Part I ≈ Part 1)", () => {
    // Windows OCR confuses digits with similarly-shaped letters: S→5, I→1,
    // O→0, Z→2, B→8. Accepting single-letter suffixes lets the merge fire,
    // and the tokenizer drops the letter so fuzzy match still lands on the
    // right series (as an ambiguous pick).
    expect(PART_FRAGMENT_RE.test("Part S")).toBe(true);
    expect(PART_FRAGMENT_RE.test("- Part I")).toBe(true);
    expect(PART_FRAGMENT_RE.test("Part Z")).toBe(true);
  });
  it("does not match multi-letter alpha suffixes", () => {
    // "Part of", "Part XII", etc. are not OCR digit misreads — don't
    // misinterpret these as Part-N fragments.
    expect(PART_FRAGMENT_RE.test("Part of")).toBe(false);
    expect(PART_FRAGMENT_RE.test("Part XII")).toBe(false);
  });
});

describe("expandSeriesAlternates", () => {
  const SERIES = [
    { id: "hcp1", name: "Health Care Privacy - Part 1" },
    { id: "hcp2", name: "Health Care Privacy - Part 2" },
    { id: "hcp3", name: "Health Care Privacy - Part 3" },
    { id: "hcp4", name: "Health Care Privacy - Part 4" },
    { id: "hcp5", name: "Health Care Privacy - Part 5" },
    { id: "debut", name: "Debut" },
    { id: "gs1", name: "Gunsmith - Part 1" },
  ];

  it("fills in Part 4 and Part 5 missing from findTopMatches's top-3", () => {
    // Simulates the Health Care Privacy regression: OCR captured "Part S",
    // fuzzy matched all 5 parts equally, top-3 returned only Parts 1-3.
    const primary = SERIES[0]; // Part 1 (first-iterated wins)
    const alternates = [SERIES[1], SERIES[2]]; // Part 2, Part 3
    const expanded = expandSeriesAlternates(primary, alternates, SERIES);
    expect(expanded.map((t) => t.id)).toEqual(["hcp2", "hcp3", "hcp4", "hcp5"]);
  });

  it("does not pull in tasks from a different series or non-series tasks", () => {
    const primary = SERIES[0];
    const expanded = expandSeriesAlternates(primary, [], SERIES);
    // Debut and Gunsmith Part 1 share no prefix with Health Care Privacy.
    expect(expanded.map((t) => t.id)).toEqual(["hcp2", "hcp3", "hcp4", "hcp5"]);
  });

  it("returns existing alternates unchanged when primary isn't in a numbered series", () => {
    const primary = SERIES.find((t) => t.id === "debut");
    const existing = [{ id: "x", name: "Something else" }];
    expect(expandSeriesAlternates(primary, existing, SERIES)).toBe(existing);
  });

  it("caps at the limit to avoid flooding UI with 25 Gunsmith parts", () => {
    const GUNSMITH = Array.from({ length: 25 }, (_, i) => ({
      id: `gs${i + 1}`,
      name: `Gunsmith - Part ${i + 1}`,
    }));
    const primary = GUNSMITH[0];
    const expanded = expandSeriesAlternates(primary, [], GUNSMITH, 8);
    expect(expanded).toHaveLength(8);
    expect(expanded[0].id).toBe("gs2");
  });
});

describe("partPrefix", () => {
  it("extracts the prefix before '- Part N'", () => {
    expect(partPrefix("Test Drive - Part 3")).toBe("test drive");
    expect(partPrefix("The Punisher – Part 5")).toBe("the punisher");
  });
  it("returns null when there's no Part suffix", () => {
    expect(partPrefix("Shaking Up the Teller")).toBe(null);
    expect(partPrefix("")).toBe(null);
  });
});

describe("isAmbiguousPartSiblings", () => {
  const td1 = { id: "td1", name: "Test Drive - Part 1" };
  const td2 = { id: "td2", name: "Test Drive - Part 2" };
  const td3 = { id: "td3", name: "Test Drive - Part 3" };

  it("flags as ambiguous when OCR lacks the Part number", () => {
    // OCR saw just "Test Drive" — primary pick was Part 1 via iteration
    // order; alternates contain Part 2, Part 3. Genuinely undecidable.
    expect(isAmbiguousPartSiblings(td1, [td2, td3], "Test Drive")).toBe(true);
  });

  it("resolves the ambiguity when OCR contains the primary's Part number", () => {
    // The Postman Pat / Colleagues regression: OCR captured "Part 2"
    // explicitly, so even though Part 1 and Part 3 are in the alternates,
    // the match IS definite.
    expect(isAmbiguousPartSiblings(td2, [td1, td3], "Test Drive - Part 2")).toBe(false);
    expect(isAmbiguousPartSiblings(td2, [td1, td3], "test drive part 2")).toBe(false);
  });

  it("returns false when there are no sibling alternates", () => {
    const unrelated = { id: "x", name: "Shaking Up the Teller" };
    expect(isAmbiguousPartSiblings(td1, [unrelated], "Test Drive")).toBe(false);
  });

  it("returns false when the primary task isn't part of a numbered series", () => {
    const plain = { id: "plain", name: "Shaking Up the Teller" };
    expect(isAmbiguousPartSiblings(plain, [td1, td2], "Shaking")).toBe(false);
  });
});
