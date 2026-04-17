// Levenshtein distance between two strings (case-insensitive)
// Strings are already lowercased by the time this is called.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Single-row DP instead of full matrix — we only need the previous row.
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Normalized similarity score (0-1, higher is better). Inputs must be lowercase.
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Length gate: if |len(a) - len(b)| exceeds maxLen*0.5, similarity is
  // already below 0.5, so skip the expensive DP for common-case dissimilar
  // pairs (cuts ~90% of fuzzy checks against the ~5k item DB).
  if (Math.abs(a.length - b.length) > maxLen * 0.5) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length >= 2);
}

// Token-level score: for each query token, find its best match among the
// candidate's tokens. Rewards coverage (more tokens matched) and average
// per-token similarity. Handles partial captures like "can stew" → "Can of
// beef stew" where plain Levenshtein on the full string fails.
//
// Substring-contains bonus only fires when the shorter token is ≥4 chars —
// otherwise "ak" matches "lucky", "flak", "knack" and floods the scorer.
// Per-token similarity is clamped so an over-eager substring bonus can't
// push a weak partial match above a strong exact one.
function tokenScore(queryTokens, candTokens) {
  if (queryTokens.length === 0 || candTokens.length === 0) return 0;

  let total = 0;
  let matched = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const ct of candTokens) {
      const shorter = qt.length < ct.length ? qt : ct;
      const longer = qt.length < ct.length ? ct : qt;
      const sub = shorter.length >= 4 && longer.includes(shorter) ? 0.1 : 0;
      const s = Math.min(1, similarity(qt, ct) + sub);
      if (s > best) best = s;
    }
    total += best;
    if (best >= 0.8) matched++;
  }

  const avg = total / queryTokens.length;
  const coverage = matched / queryTokens.length;
  // Penalty for extra candidate tokens not explained by the query, so
  // "AK-74" doesn't tie "AK-74N scope rail"
  const extras = Math.max(0, candTokens.length - queryTokens.length);
  const lengthPenalty = Math.min(0.15, extras * 0.04);
  return avg * 0.4 + coverage * 0.6 - lengthPenalty;
}

/**
 * Pre-compute lowercased strings + tokens for each item.
 * Call once when the item DB loads, then pass the result to findBestMatch.
 * Saves ~5k tokenize() calls per 750ms scan.
 */
export function buildMatchIndex(items) {
  return (items || []).map((item) => ({
    item,
    nameLc: (item.name || "").toLowerCase(),
    shortLc: (item.shortName || "").toLowerCase(),
    tokens: tokenize(item.name || ""),
  }));
}

function normalizeIndex(indexOrItems) {
  if (!indexOrItems) return null;
  // Heuristic: already an index if first element has nameLc precomputed.
  if (indexOrItems[0] && "nameLc" in indexOrItems[0]) return indexOrItems;
  return buildMatchIndex(indexOrItems);
}

/**
 * Find the best matching item from the database for OCR text.
 * Accepts either a raw item array or a pre-built match index (preferred).
 */
export function findBestMatch(ocrText, indexOrItems, threshold = 0.5) {
  const rows = normalizeIndex(indexOrItems);
  if (!ocrText || ocrText.length < 2 || !rows?.length) return null;

  const query = ocrText.toLowerCase().trim();
  const queryTokens = tokenize(query);
  let bestItem = null;
  let bestScore = 0;

  for (const row of rows) {
    // Check shortName (most likely to match OCR of icon text)
    const shortScore = similarity(query, row.shortLc);
    const shortContains = row.shortLc.includes(query) ? 0.15 : 0;
    const sScore = shortScore + shortContains;

    // Full-string name similarity
    const nameScore = similarity(query, row.nameLc) * 0.8;
    const nameContains = row.nameLc.includes(query) ? 0.15 : 0;
    const nScore = nameScore + nameContains;

    // Token-based name score — handles partial captures and extra words
    const tScore = tokenScore(queryTokens, row.tokens);

    const score = Math.max(sScore, nScore, tScore);
    if (score > bestScore) {
      bestScore = score;
      bestItem = row.item;
    }
  }

  if (bestScore >= threshold) {
    return { item: bestItem, score: bestScore };
  }
  return null;
}

/**
 * Find top N matches for OCR text.
 */
export function findTopMatches(ocrText, indexOrItems, n = 5, threshold = 0.4) {
  const rows = normalizeIndex(indexOrItems);
  if (!ocrText || ocrText.length < 2 || !rows?.length) return [];

  const query = ocrText.toLowerCase().trim();
  const queryTokens = tokenize(query);
  const scored = [];

  for (const row of rows) {
    const shortScore = similarity(query, row.shortLc);
    const shortContains = row.shortLc.includes(query) ? 0.15 : 0;
    const nameScore = similarity(query, row.nameLc) * 0.8;
    const nameContains = row.nameLc.includes(query) ? 0.15 : 0;
    const tScore = tokenScore(queryTokens, row.tokens);
    const score = Math.max(shortScore + shortContains, nameScore + nameContains, tScore);

    if (score >= threshold) {
      scored.push({ item: row.item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}
