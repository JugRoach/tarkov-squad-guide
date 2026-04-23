// Shared regexes + helpers for the task scanner modal. Lives here (not in
// TaskScannerModal.jsx) so Vite's Fast Refresh boundary stays on the
// component file — mixing a React default export with named utility
// exports breaks incremental HMR.

// Matches a full fragment line: either "- Part N" / "– Part N" or bare
// "Part N" with nothing trailing. Also accepts a single-letter suffix
// ("Part S", "Part I", "Part O") because Windows OCR frequently misreads
// digits as letters — 5→S, 1→I, 0→O, 2→Z, etc. The merged line's
// tokenizer drops single-letter tokens anyway, so the series ends up
// matching ambiguously and the user gets a Part-picker in alternates.
// Used BOTH for the merge (pull this fragment up into the previous line)
// and for the orphan drop (remove any fragment that couldn't find a parent
// so it doesn't fuzzy-match random Part-N tasks).
export const PART_FRAGMENT_RE = /^(?:[-–]\s*)?part\s+(?:\d+|[a-z])\s*$/i;
const PART_SUFFIX_RE = /\bpart\s+\d+\s*$/i;
export const PART_NUM_RE = /\bpart\s+(\d+)\b/i;
export const PART_RE = /\s*[-–]\s*part\s+\d+\s*$/i;

// Notebook column headers and the shortest UI-chrome labels that OCR reads
// between the task list columns. Used to let the merge lookahead jump over
// these when the task name got truncated onto two non-adjacent OCR lines.
const CHROME_WORDS = new Set([
  "task", "tasks", "location", "trader", "type", "status", "progress",
]);
function isLikelyChrome(line) {
  if (!line) return true;
  const t = line.trim();
  if (t.length <= 3) return true;
  return CHROME_WORDS.has(t.toLowerCase());
}

const TRAILING_DASH_RE = /[-–]\s*$/;

/**
 * Reconstruct task names that OCR wrapped across two (or more) lines.
 * Two patterns seen in the wild:
 *
 *   1. Adjacent:   "Test Drive" / "- Part 3"         → merge → "Test Drive - Part 3"
 *   2. Interleaved: "The Bunker -" / "Task" / "Part 1" → merge across the
 *      "Task" column header → "The Bunker - Part 1"
 *
 * The lookahead variant only kicks in when `curr` ends with a trailing dash
 * (a strong "OCR truncated me" signal) and only skips lines that look like
 * column headers or ≤3-char garbage. This keeps merges conservative — a
 * legitimate single-token task name like "Debut" won't swallow unrelated
 * Part-N fragments from elsewhere on the screen.
 */
export function mergeTaskLines(lines) {
  const nonEmpty = (lines || [])
    .map((l) => (l || "").trim())
    .filter((l) => l.length > 0);
  const out = [];
  let i = 0;
  while (i < nonEmpty.length) {
    const curr = nonEmpty[i];
    // Already a complete task name with Part suffix — don't merge.
    if (PART_SUFFIX_RE.test(curr)) {
      out.push(curr);
      i++;
      continue;
    }
    // Case 1: immediate adjacency. Handles the simple "Test Drive" / "- Part 3"
    // OCR split regardless of whether curr has a trailing dash.
    if (i + 1 < nonEmpty.length && PART_FRAGMENT_RE.test(nonEmpty[i + 1])) {
      out.push(`${curr} ${nonEmpty[i + 1]}`);
      i += 2;
      continue;
    }
    // Case 2: curr looks truncated (ends with a dash). Look ahead past
    // chrome lines for a Part-N fragment. If we hit real non-chrome content
    // first, abandon the lookahead — the fragment probably belongs to a
    // different row.
    if (TRAILING_DASH_RE.test(curr)) {
      let mergeIdx = -1;
      for (let j = i + 1; j < Math.min(i + 4, nonEmpty.length); j++) {
        if (PART_FRAGMENT_RE.test(nonEmpty[j])) { mergeIdx = j; break; }
        if (!isLikelyChrome(nonEmpty[j])) break;
      }
      if (mergeIdx > i) {
        out.push(`${curr} ${nonEmpty[mergeIdx]}`);
        // Skip past the merged fragment. Intervening chrome lines get
        // dropped — they were noise anyway.
        i = mergeIdx + 1;
        continue;
      }
    }
    out.push(curr);
    i++;
  }
  return out;
}

export function partPrefix(name) {
  if (!name) return null;
  const m = PART_RE.exec(name);
  if (!m) return null;
  return name.slice(0, m.index).trim().toLowerCase();
}

/**
 * Flag numbered-series proposals (Test Drive - Part 1/2/3, Gunsmith - Part
 * 1..25) where OCR couldn't disambiguate which Part. Returns true ONLY when
 * siblings share the primary's prefix AND the OCR line doesn't explicitly
 * contain the primary's Part number — i.e. the match is genuinely
 * undecidable from the OCR and the user should manually pick.
 */
/**
 * For an ambiguous Part-N match where OCR couldn't capture the number,
 * expand the alternates list to include every sibling in the series (sorted
 * by Part number). `findTopMatches` only returns 3 candidates, which
 * systematically hides Part 5/6/7 when Parts 1-3 score identically.
 * Capped at `limit` so Gunsmith 1-25 doesn't flood the UI.
 */
export function expandSeriesAlternates(primaryTask, existingAlternates, allTasks, limit = 10) {
  const prefix = partPrefix(primaryTask?.name);
  if (!prefix) return existingAlternates || [];
  const seen = new Set([primaryTask?.id, ...(existingAlternates || []).map((a) => a?.id)].filter(Boolean));
  const extras = (allTasks || [])
    .filter((t) => t && !seen.has(t.id) && partPrefix(t.name) === prefix)
    .sort((a, b) => {
      const an = parseInt(PART_NUM_RE.exec(a.name)?.[1] || "0", 10);
      const bn = parseInt(PART_NUM_RE.exec(b.name)?.[1] || "0", 10);
      return an - bn;
    });
  const merged = [...(existingAlternates || []), ...extras];
  return merged.slice(0, limit);
}

export function isAmbiguousPartSiblings(primaryTask, alternates, ocrLine) {
  const prefix = partPrefix(primaryTask?.name);
  if (!prefix) return false;
  const hasSibling = (alternates || []).some((a) => partPrefix(a?.name) === prefix);
  if (!hasSibling) return false;
  const primaryN = PART_NUM_RE.exec(primaryTask?.name || "")?.[1];
  if (primaryN) {
    const ocrN = PART_NUM_RE.exec(ocrLine || "")?.[1];
    if (ocrN === primaryN) return false;
  }
  return true;
}
