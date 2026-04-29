import PRECOMPUTED_BUILDS from "../data/precomputed-builds.json";

// Conflict-aware branch-and-bound optimizer for Tarkov weapon builds.
//
// Three B&B variants live in this file:
//
// 1. `optimizeSlots` (scalar) — used by "ergo" and "recoil" modes. Tries
//    each compatible candidate per slot, recurses into sub-slots. Score
//    is additive; pruned via per-slot upper bounds (unconstrained
//    per-item max sum over the subtree) and UB-sorted slot order.
//
// 2. `optimizeTargeted` (recoil + ergo floor) — used by "recoil-balanced"
//    mode. Hard ergo floor at maxErgo/2; maximizes recoil reduction
//    subject to that floor.
//
// 3. `optimizeCustom` (dual floors) — used by "custom" mode. User picks
//    eTarget and rTarget independently. Score is `totalErgo + totalRecoil`,
//    softened by an infeasibility penalty so the optimizer falls back to
//    the closest-feasible build when targets can't be met.
//
// All three respect:
//   - `skipSlot(nameId)` — implicit slot skip (default: scope/sight/magazine).
//   - `lockedPaths` — explicit per-path locks. Forced paths preserve
//     `currentMods[path]` and participate in the conflict pool.
//
// "Forced" = skipSlot match OR path in lockedPaths. Either way the slot
// is treated as fixed during DFS: no branching, just descend into the
// forced mod's sub-slots (which themselves may be forced or free).

const DEFAULT_SKIP = /scope|sight|magazine/i;
function defaultSkipSlot(nameId) {
  return DEFAULT_SKIP.test(nameId || "");
}

// Legacy weight on the deprecated weighted-sum "recoil-balanced" formula.
// Unused by the target-based optimizer — kept at 1.0 in case anything
// still calls scoreMod with mode="recoil-balanced".
const BAL_RECOIL_WEIGHT = 1.0;

// How many recoil points are forfeited per 1 ergo below target in the
// "recoil-balanced" two-axis B&B. λ=1 means a mod buying 1 pt of recoil
// reduction must close at least 1 ergo of target-gap to be worth taking.
const BAL_ERGO_PENALTY = 1.0;

// Penalty multiplier for CUSTOM mode infeasibility. With penalty > 1 a
// 1-unit deficit reduction is worth more than a 1-unit raw-score gain,
// so the optimizer prioritizes reaching feasibility before chasing slack.
// Once feasible (deficit = 0), score reduces to E + R and slack is
// maximized.
const CUSTOM_INFEASIBILITY_PENALTY = 2.0;

const EMPTY_SET = Object.freeze(new Set());

function scoreMod(mp, mode) {
  if (!mp) return 0;
  if (mode === "ergo") return mp.ergonomics || 0;
  if (mode === "ergoplusrecoil") {
    // Single-item combined R + E. Used by optimizeCustom for a tighter
    // score-axis UB than restR + restE (those count max-R and max-E
    // independently per slot — usually picked from different items).
    return (mp.ergonomics || 0) + (-(mp.recoilModifier || 0)) * 100;
  }
  if (mode === "recoil-balanced") {
    const rec = -(mp.recoilModifier || 0) * 100 * BAL_RECOIL_WEIGHT;
    const ergo = mp.ergonomics || 0;
    const acc = (mp.accuracyModifier || 0) * 100;
    return rec + ergo + acc;
  }
  // "recoil" mode: scale to percentage points so this matches
  // recoilContrib's units. Without ×100, optimizeTargeted and
  // optimizeCustom mix scales (curR uses ×100, restR uses ×1) and
  // their UB pruning fires incorrectly. Relative ranking is preserved
  // either way, so OPT RECOIL itself produces the same picks; the fix
  // is necessary for the dual-axis B&Bs.
  return -(mp.recoilModifier || 0) * 100;
}

function isCompatible(item, chosenIds, conflictPool) {
  if (conflictPool.has(item.id)) return false;
  const cis = item.conflictingItems;
  if (cis) {
    for (const c of cis) {
      if (chosenIds.has(c.id)) return false;
    }
  }
  return true;
}

function isForced(path, slot, ctx) {
  return ctx.skipSlot(slot.nameId) || ctx.lockedPaths.has(path);
}

// Returns the locked/skipped mod object at `path`, or null if the slot
// is forced-empty or the locked id no longer matches an allowed item.
// IMPORTANT: searches the FULL allowedItems list, not the dominance-
// filtered one — a user-locked mod might be dominated (and absent
// from the filtered list) but we still need to honor the lock.
function getForcedMod(slot, path, ctx) {
  const id = ctx.currentMods[path];
  if (!id) return null;
  return slot?.filters?.allowedItems?.find((i) => i.id === id) || null;
}

// Per-slot dominance filter. Two items in the same slot's allowed-items
// list are interchangeable from the optimizer's point of view if one is
// at least as good in R, at least as good in E, and is at least as
// compatible (subset of forward conflicts AND subset of reverse
// conflicts). Strictly-dominated items can never be in any optimal
// build, so we drop them — the picker UI still shows everything, but
// the B&B branches get cut down.
//
// Why both forward AND reverse conflicts? An item is incompatible if
// (a) something it conflicts with is chosen, OR (b) something that
// conflicts with it is chosen. (b) requires a reverse-lookup map.
// Tarkov's conflictingItems are usually symmetric so the two sets
// coincide, but the API has occasional asymmetries — checking both is
// the only correctness-preserving rule.
const dominanceCache = new WeakMap();
const reverseConflictsCache = new WeakMap();

function getReverseConflicts(weapon) {
  if (!weapon) return new Map();
  if (reverseConflictsCache.has(weapon)) return reverseConflictsCache.get(weapon);
  const reverse = new Map();
  const walk = (slots) => {
    if (!slots) return;
    for (const slot of slots) {
      for (const item of slot.filters?.allowedItems || []) {
        for (const c of item.conflictingItems || []) {
          let set = reverse.get(c.id);
          if (!set) {
            set = new Set();
            reverse.set(c.id, set);
          }
          set.add(item.id);
        }
        if (item.properties?.slots) walk(item.properties.slots);
      }
    }
  };
  walk(weapon?.properties?.slots);
  reverseConflictsCache.set(weapon, reverse);
  return reverse;
}

function getFilteredItems(slot, ctx) {
  // isAvailable changes the effective candidate set per call; skip
  // dominance caching to avoid baking in a profile-dependent answer.
  if (ctx?.isAvailable) return slot?.filters?.allowedItems || [];
  if (dominanceCache.has(slot)) return dominanceCache.get(slot);
  const items = slot?.filters?.allowedItems || [];
  if (items.length <= 1) {
    dominanceCache.set(slot, items);
    return items;
  }

  const reverseMap = getReverseConflicts(ctx?.weapon);
  const scored = items.map((it) => ({
    item: it,
    R: -(it.properties?.recoilModifier || 0) * 100,
    E: it.properties?.ergonomics || 0,
    forward: new Set((it.conflictingItems || []).map((c) => c.id)),
    reverse: reverseMap.get(it.id) || new Set(),
  }));

  const kept = [];
  for (let i = 0; i < scored.length; i++) {
    const candidate = scored[i];
    let dominated = false;
    for (let j = 0; j < scored.length; j++) {
      if (i === j) continue;
      const other = scored[j];
      if (other.R < candidate.R || other.E < candidate.E) continue;
      const strict =
        other.R > candidate.R ||
        other.E > candidate.E ||
        other.forward.size < candidate.forward.size ||
        other.reverse.size < candidate.reverse.size;
      if (!strict) continue;
      let subset = true;
      for (const c of other.forward) {
        if (!candidate.forward.has(c)) { subset = false; break; }
      }
      if (!subset) continue;
      for (const c of other.reverse) {
        if (!candidate.reverse.has(c)) { subset = false; break; }
      }
      if (subset) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(candidate.item);
  }

  dominanceCache.set(slot, kept);
  return kept;
}

// Path-aware admissible UB on score for a slot at `path`. Cached per
// path (Map) — same slot encountered at different paths can have different
// UBs because forced status is per-path. Cache lifetime is per optimizer
// call (ctx.ubCache is created fresh).
function ubForSlot(slot, path, ctx) {
  if (ctx.ubCache.has(path)) return ctx.ubCache.get(path);

  if (isForced(path, slot, ctx)) {
    const mod = getForcedMod(slot, path, ctx);
    if (!mod) {
      ctx.ubCache.set(path, 0);
      return 0;
    }
    let total = scoreMod(mod.properties, ctx.mode);
    const subSlots = mod.properties?.slots || [];
    for (const sub of subSlots) {
      total += ubForSlot(sub, `${path}.${sub.nameId}`, ctx);
    }
    ctx.ubCache.set(path, total);
    return total;
  }

  const items = getFilteredItems(slot, ctx);
  if (items.length === 0) {
    ctx.ubCache.set(path, 0);
    return 0;
  }
  let maxItemUB = slot.required ? -Infinity : 0;
  for (const item of items) {
    if (ctx.isAvailable && !ctx.isAvailable(item)) continue;
    let total = scoreMod(item.properties, ctx.mode);
    const subSlots = item.properties?.slots || [];
    for (const sub of subSlots) {
      total += ubForSlot(sub, `${path}.${sub.nameId}`, ctx);
    }
    if (total > maxItemUB) maxItemUB = total;
  }
  ctx.ubCache.set(path, maxItemUB);
  return maxItemUB;
}

// Greedy subtree evaluator. Used to seed the scalar B&B with a
// non-trivial lower bound. Forced slots descend into the locked mod;
// free slots try natural sibling order.
function greedySubtree(slot, path, ctx, chosenIds, conflictPool) {
  const items = getFilteredItems(slot, ctx);
  if (items.length === 0) return { score: 0, mods: {}, picked: [] };

  if (isForced(path, slot, ctx)) {
    const mod = getForcedMod(slot, path, ctx);
    if (!mod) return { score: 0, mods: {}, picked: [] };
    if (!isCompatible(mod, chosenIds, conflictPool)) {
      // Locked mod conflicts with already-chosen state. Surface as
      // failure (-Infinity) so the caller knows greedy can't satisfy
      // every lock; B&B will then explore alternatives that respect
      // the locks. If no such alternative exists (mutually-conflicting
      // user locks), the optimizer falls back to {} mods.
      return { score: -Infinity, mods: {}, picked: [] };
    }
    const localChosen = new Set(chosenIds);
    localChosen.add(mod.id);
    const localConflicts = new Set(conflictPool);
    if (mod.conflictingItems) {
      for (const c of mod.conflictingItems) localConflicts.add(c.id);
    }
    let subScore = 0;
    const subMods = { [path]: mod.id };
    const subPicked = [mod];
    const subSlots = mod.properties?.slots || [];
    for (const sub of subSlots) {
      const subPath = `${path}.${sub.nameId}`;
      const subBest = greedySubtree(sub, subPath, ctx, localChosen, localConflicts);
      if (subBest.score === -Infinity) {
        if (sub.required) return { score: -Infinity, mods: {}, picked: [] };
        continue;
      }
      subScore += subBest.score;
      Object.assign(subMods, subBest.mods);
      for (const m of subBest.picked) {
        subPicked.push(m);
        localChosen.add(m.id);
        if (m.conflictingItems) {
          for (const c of m.conflictingItems) localConflicts.add(c.id);
        }
      }
    }
    return {
      score: scoreMod(mod.properties, ctx.mode) + subScore,
      mods: subMods,
      picked: subPicked,
    };
  }

  let best = slot.required
    ? { score: -Infinity, mods: {}, picked: [] }
    : { score: 0, mods: {}, picked: [] };

  for (const item of items) {
    if (ctx.isAvailable && !ctx.isAvailable(item)) continue;
    if (!isCompatible(item, chosenIds, conflictPool)) continue;

    const localChosen = new Set(chosenIds);
    localChosen.add(item.id);
    const localConflicts = new Set(conflictPool);
    if (item.conflictingItems) {
      for (const c of item.conflictingItems) localConflicts.add(c.id);
    }

    let subScore = 0;
    const subMods = { [path]: item.id };
    const subPicked = [item];
    const subSlots = item.properties?.slots || [];
    for (const sub of subSlots) {
      const subPath = `${path}.${sub.nameId}`;
      const subBest = greedySubtree(sub, subPath, ctx, localChosen, localConflicts);
      if (subBest.score === -Infinity) continue;
      subScore += subBest.score;
      Object.assign(subMods, subBest.mods);
      for (const m of subBest.picked) {
        subPicked.push(m);
        localChosen.add(m.id);
        if (m.conflictingItems) {
          for (const c of m.conflictingItems) localConflicts.add(c.id);
        }
      }
    }

    const total = scoreMod(item.properties, ctx.mode) + subScore;
    if (total > best.score) {
      best = { score: total, mods: subMods, picked: subPicked };
    }
  }
  return best;
}

function greedyFillSlots(active, pathPrefix, ctx, initialChosen, initialConflicts) {
  // Two-pass: forced slots first (deterministic, populate the conflict
  // pool with locked-in mods), then free slots (work around the locks).
  // Without this ordering greedy can pick a free mod that conflicts
  // with a later forced slot, then fall back to dropping the lock.
  const forcedSlots = [];
  const freeSlots = [];
  for (const slot of active) {
    const path = pathPrefix ? `${pathPrefix}.${slot.nameId}` : slot.nameId;
    if (isForced(path, slot, ctx)) forcedSlots.push(slot);
    else freeSlots.push(slot);
  }

  let score = 0;
  const mods = {};
  const picked = [];
  const chosenIds = new Set(initialChosen);
  const conflictPool = new Set(initialConflicts);

  for (const slot of [...forcedSlots, ...freeSlots]) {
    const path = pathPrefix ? `${pathPrefix}.${slot.nameId}` : slot.nameId;
    const sub = greedySubtree(slot, path, ctx, chosenIds, conflictPool);
    if (sub.score === -Infinity) return { score: -Infinity, mods: {}, picked: [] };
    score += sub.score;
    Object.assign(mods, sub.mods);
    for (const m of sub.picked) {
      picked.push(m);
      chosenIds.add(m.id);
      if (m.conflictingItems) {
        for (const c of m.conflictingItems) conflictPool.add(c.id);
      }
    }
  }
  return { score, mods, picked };
}

// Scalar B&B over a list of slots. Forced paths handled inline (no
// branching, just descend).
function optimizeSlots(slots, pathPrefix, ctx, initialChosen, initialConflicts) {
  const active = slots
    .filter((s) => s?.filters?.allowedItems?.length > 0)
    .slice()
    .sort((a, b) => {
      const pa = pathPrefix ? `${pathPrefix}.${a.nameId}` : a.nameId;
      const pb = pathPrefix ? `${pathPrefix}.${b.nameId}` : b.nameId;
      // Forced (locked / skipSlot) slots first — surfaces lock conflicts
      // early so B&B can prune lock-incompatible branches before
      // exploring deep. UB-desc within each bucket.
      const fa = isForced(pa, a, ctx);
      const fb = isForced(pb, b, ctx);
      if (fa !== fb) return fa ? -1 : 1;
      return ubForSlot(b, pb, ctx) - ubForSlot(a, pa, ctx);
    });

  if (active.length === 0) return { score: 0, mods: {}, picked: [] };

  const ubs = active.map((s) => {
    const p = pathPrefix ? `${pathPrefix}.${s.nameId}` : s.nameId;
    return ubForSlot(s, p, ctx);
  });
  const suffixUB = new Array(active.length + 1).fill(0);
  for (let i = active.length - 1; i >= 0; i--) {
    suffixUB[i] = suffixUB[i + 1] + ubs[i];
  }

  let best = greedyFillSlots(active, pathPrefix, ctx, initialChosen, initialConflicts);
  if (best.score === -Infinity) {
    best = { score: 0, mods: {}, picked: [] };
  }

  function dfs(i, curScore, curMods, curPicked, curChosen, curConflicts) {
    if (curScore + suffixUB[i] <= best.score) return;
    if (i === active.length) {
      if (curScore > best.score) {
        best = { score: curScore, mods: curMods, picked: curPicked };
      }
      return;
    }
    const slot = active[i];
    const path = pathPrefix ? `${pathPrefix}.${slot.nameId}` : slot.nameId;

    if (isForced(path, slot, ctx)) {
      const mod = getForcedMod(slot, path, ctx);
      if (!mod) {
        // Locked-empty (or skipSlot with no current pick): slot stays
        // empty, optimizer doesn't try to fill it.
        dfs(i + 1, curScore, curMods, curPicked, curChosen, curConflicts);
        return;
      }
      if (!isCompatible(mod, curChosen, curConflicts)) {
        // Lock conflicts with already-chosen state — this branch can't
        // honor the lock. PRUNE (return) so the optimizer backtracks
        // and tries alternatives that respect the lock.
        return;
      }
      const newChosen = new Set(curChosen);
      newChosen.add(mod.id);
      const newConflicts = new Set(curConflicts);
      if (mod.conflictingItems) {
        for (const c of mod.conflictingItems) newConflicts.add(c.id);
      }
      const subSlots = mod.properties?.slots || [];
      const subBest = optimizeSlots(subSlots, path, ctx, newChosen, newConflicts);
      if (subBest.score === -Infinity) return;
      for (const m of subBest.picked) {
        newChosen.add(m.id);
        if (m.conflictingItems) {
          for (const c of m.conflictingItems) newConflicts.add(c.id);
        }
      }
      const itemScore = scoreMod(mod.properties, ctx.mode);
      dfs(
        i + 1,
        curScore + itemScore + subBest.score,
        { ...curMods, [path]: mod.id, ...subBest.mods },
        [...curPicked, mod, ...subBest.picked],
        newChosen,
        newConflicts
      );
      return;
    }

    if (!slot.required) {
      dfs(i + 1, curScore, curMods, curPicked, curChosen, curConflicts);
    }

    const items = getFilteredItems(slot, ctx);
    const compatible = [];
    for (const it of items) {
      if (ctx.isAvailable && !ctx.isAvailable(it)) continue;
      if (!isCompatible(it, curChosen, curConflicts)) continue;
      compatible.push(it);
    }
    compatible.sort(
      (a, b) => scoreMod(b.properties, ctx.mode) - scoreMod(a.properties, ctx.mode)
    );

    for (const it of compatible) {
      const newChosen = new Set(curChosen);
      newChosen.add(it.id);
      const newConflicts = new Set(curConflicts);
      if (it.conflictingItems) {
        for (const c of it.conflictingItems) newConflicts.add(c.id);
      }

      const subSlots = it.properties?.slots || [];
      const subBest = optimizeSlots(subSlots, path, ctx, newChosen, newConflicts);
      if (subBest.score === -Infinity) continue;

      for (const m of subBest.picked) {
        newChosen.add(m.id);
        if (m.conflictingItems) {
          for (const c of m.conflictingItems) newConflicts.add(c.id);
        }
      }

      const itemScore = scoreMod(it.properties, ctx.mode);
      dfs(
        i + 1,
        curScore + itemScore + subBest.score,
        { ...curMods, [path]: it.id, ...subBest.mods },
        [...curPicked, it, ...subBest.picked],
        newChosen,
        newConflicts
      );
    }
  }

  dfs(0, 0, {}, [], initialChosen, initialConflicts);
  return best;
}

// ---- Two-axis helpers ----

function recoilContrib(mp) {
  return -(mp?.recoilModifier || 0) * 100;
}

function ergoContrib(mp) {
  return mp?.ergonomics || 0;
}

export function computeTotalErgo(weapon, mods) {
  let total = weapon?.properties?.ergonomics || 0;
  const walk = (slots, prefix) => {
    if (!slots) return;
    for (const slot of slots) {
      const path = prefix ? `${prefix}.${slot.nameId}` : slot.nameId;
      const modId = mods[path];
      if (!modId) continue;
      const mod = slot.filters?.allowedItems?.find((i) => i.id === modId);
      if (!mod) continue;
      total += mod.properties?.ergonomics || 0;
      if (mod.properties?.slots) walk(mod.properties.slots, path);
    }
  };
  walk(weapon?.properties?.slots || [], "");
  return total;
}

export function computeTotalRecoil(weapon, mods) {
  let total = 0;
  const walk = (slots, prefix) => {
    if (!slots) return;
    for (const slot of slots) {
      const path = prefix ? `${prefix}.${slot.nameId}` : slot.nameId;
      const modId = mods[path];
      if (!modId) continue;
      const mod = slot.filters?.allowedItems?.find((i) => i.id === modId);
      if (!mod) continue;
      total += recoilContrib(mod.properties);
      if (mod.properties?.slots) walk(mod.properties.slots, path);
    }
  };
  walk(weapon?.properties?.slots || [], "");
  return total;
}

// ---- "recoil-balanced" target-ergo optimizer ----
//
// Maximizes recoil reduction subject to a hard ergo floor (totalErgo >=
// targetTotalErgo). Conflict-aware, dual-axis UB pruning + feasibility
// pruning kills whole subtrees whose max attainable ergo can't reach
// the floor.

function optimizeTargeted(weapon, ctx, targetTotalErgo) {
  const baseErgo = weapon?.properties?.ergonomics || 0;
  const targetModErgo = targetTotalErgo - baseErgo;
  const topSlots = weapon?.properties?.slots || [];

  const rCtx = { ...ctx, mode: "recoil", ubCache: new Map() };
  const eCtx = { ...ctx, mode: "ergo", ubCache: new Map() };

  const stack = [];
  for (const s of topSlots) {
    if (!(s?.filters?.allowedItems?.length > 0)) continue;
    stack.push({ slot: s, pathPrefix: "" });
  }
  // LIFO: forced slots popped first (end of array), then highest-R-UB.
  stack.sort((a, b) => {
    const pa = a.pathPrefix ? `${a.pathPrefix}.${a.slot.nameId}` : a.slot.nameId;
    const pb = b.pathPrefix ? `${b.pathPrefix}.${b.slot.nameId}` : b.slot.nameId;
    const fa = isForced(pa, a.slot, ctx);
    const fb = isForced(pb, b.slot, ctx);
    if (fa !== fb) return fa ? 1 : -1;
    return ubForSlot(a.slot, pa, rCtx) - ubForSlot(b.slot, pb, rCtx);
  });

  let restR = 0;
  let restE = 0;
  for (const e of stack) {
    const p = e.pathPrefix ? `${e.pathPrefix}.${e.slot.nameId}` : e.slot.nameId;
    restR += ubForSlot(e.slot, p, rCtx);
    restE += ubForSlot(e.slot, p, eCtx);
  }

  if (restE < targetModErgo) return null;

  let best = {
    score: -Infinity,
    mods: {},
    picked: [],
    totalRecoil: 0,
    totalErgo: baseErgo,
  };

  function dfs(curR, curE, curMods, curPicked, curChosen, curConflicts) {
    if (curR + restR <= best.score) return;
    if (curE + restE < targetModErgo) return;

    if (stack.length === 0) {
      if (curE >= targetModErgo && curR > best.score) {
        best = {
          score: curR,
          mods: curMods,
          picked: curPicked,
          totalRecoil: curR,
          totalErgo: baseErgo + curE,
        };
      }
      return;
    }

    const top = stack.pop();
    const slot = top.slot;
    const path = top.pathPrefix ? `${top.pathPrefix}.${slot.nameId}` : slot.nameId;
    const slotUR = ubForSlot(slot, path, rCtx);
    const slotUE = ubForSlot(slot, path, eCtx);
    restR -= slotUR;
    restE -= slotUE;

    if (isForced(path, slot, ctx)) {
      const mod = getForcedMod(slot, path, ctx);
      if (!mod) {
        // Locked-empty: slot stays empty, advance.
        dfs(curR, curE, curMods, curPicked, curChosen, curConflicts);
      } else if (!isCompatible(mod, curChosen, curConflicts)) {
        // Lock conflicts — PRUNE (don't advance, force backtrack).
      } else {
        const newChosen = new Set(curChosen);
        newChosen.add(mod.id);
        const newConflicts = new Set(curConflicts);
        if (mod.conflictingItems) {
          for (const c of mod.conflictingItems) newConflicts.add(c.id);
        }
        const itemR = recoilContrib(mod.properties);
        const itemE = ergoContrib(mod.properties);
        const subSlots = mod.properties?.slots || [];
        const pushed = [];
        for (const s of subSlots) {
          if (!(s?.filters?.allowedItems?.length > 0)) continue;
          pushed.push({ slot: s, pathPrefix: path });
        }
        pushed.sort((a, b) => {
          const pa = `${a.pathPrefix}.${a.slot.nameId}`;
          const pb = `${b.pathPrefix}.${b.slot.nameId}`;
          // Forced sub-slots popped first (end of stack); UB asc within bucket.
          const fa = isForced(pa, a.slot, ctx);
          const fb = isForced(pb, b.slot, ctx);
          if (fa !== fb) return fa ? 1 : -1;
          return ubForSlot(a.slot, pa, rCtx) - ubForSlot(b.slot, pb, rCtx);
        });
        for (const entry of pushed) {
          const p = `${entry.pathPrefix}.${entry.slot.nameId}`;
          stack.push(entry);
          restR += ubForSlot(entry.slot, p, rCtx);
          restE += ubForSlot(entry.slot, p, eCtx);
        }
        dfs(
          curR + itemR,
          curE + itemE,
          { ...curMods, [path]: mod.id },
          [...curPicked, mod],
          newChosen,
          newConflicts
        );
        for (let j = 0; j < pushed.length; j++) {
          const entry = stack.pop();
          const p = `${entry.pathPrefix}.${entry.slot.nameId}`;
          restR -= ubForSlot(entry.slot, p, rCtx);
          restE -= ubForSlot(entry.slot, p, eCtx);
        }
      }
      stack.push(top);
      restR += slotUR;
      restE += slotUE;
      return;
    }

    if (!slot.required) {
      dfs(curR, curE, curMods, curPicked, curChosen, curConflicts);
    }

    const items = getFilteredItems(slot, ctx);
    const compatible = [];
    for (const it of items) {
      if (ctx.isAvailable && !ctx.isAvailable(it)) continue;
      if (!isCompatible(it, curChosen, curConflicts)) continue;
      compatible.push(it);
    }
    compatible.sort(
      (a, b) => recoilContrib(b.properties) - recoilContrib(a.properties)
    );

    for (const it of compatible) {
      const newChosen = new Set(curChosen);
      newChosen.add(it.id);
      const newConflicts = new Set(curConflicts);
      if (it.conflictingItems) {
        for (const c of it.conflictingItems) newConflicts.add(c.id);
      }
      const itemR = recoilContrib(it.properties);
      const itemE = ergoContrib(it.properties);
      const subSlots = it.properties?.slots || [];
      const pushed = [];
      for (const s of subSlots) {
        if (!(s?.filters?.allowedItems?.length > 0)) continue;
        pushed.push({ slot: s, pathPrefix: path });
      }
      pushed.sort((a, b) => {
        const pa = `${a.pathPrefix}.${a.slot.nameId}`;
        const pb = `${b.pathPrefix}.${b.slot.nameId}`;
        const fa = isForced(pa, a.slot, ctx);
        const fb = isForced(pb, b.slot, ctx);
        if (fa !== fb) return fa ? 1 : -1;
        return ubForSlot(a.slot, pa, rCtx) - ubForSlot(b.slot, pb, rCtx);
      });
      for (const entry of pushed) {
        const p = `${entry.pathPrefix}.${entry.slot.nameId}`;
        stack.push(entry);
        restR += ubForSlot(entry.slot, p, rCtx);
        restE += ubForSlot(entry.slot, p, eCtx);
      }
      dfs(
        curR + itemR,
        curE + itemE,
        { ...curMods, [path]: it.id },
        [...curPicked, it],
        newChosen,
        newConflicts
      );
      for (let j = 0; j < pushed.length; j++) {
        const entry = stack.pop();
        const p = `${entry.pathPrefix}.${entry.slot.nameId}`;
        restR -= ubForSlot(entry.slot, p, rCtx);
        restE -= ubForSlot(entry.slot, p, eCtx);
      }
    }

    stack.push(top);
    restR += slotUR;
    restE += slotUE;
  }

  dfs(0, 0, {}, [], EMPTY_SET, EMPTY_SET);
  return best.score === -Infinity ? null : best;
}

// ---- Bit-vector compilation ----
//
// Pre-pass over a weapon that assigns each unique item a sequential
// bit index and precomputes its forward conflict mask (Uint32Array of
// bits for items it conflicts with). Once compiled, isCompatible
// becomes a constant-number-of-words bitwise AND test, and the
// chosen-set / conflict-pool become Uint32Array masks that can be
// updated in place during DFS via OR / XOR — no Set allocations,
// no string hashing, no GC pressure.
//
// Forward-only masks are sufficient even for asymmetric conflicts:
// "Y conflicts with X" is encoded in Y's forward mask, so when Y is
// chosen we OR Y.mask into the conflict pool, putting X's bit there.
// X's compatibility check sees its bit in the conflict pool → fails.
// Symmetric and asymmetric cases both fall out correctly.

const weaponCompileCache = new WeakMap();

function compileWeapon(weapon) {
  if (weaponCompileCache.has(weapon)) return weaponCompileCache.get(weapon);

  const idToBit = new Map();
  const items = [];
  const walk = (slots) => {
    if (!slots) return;
    for (const slot of slots) {
      for (const item of slot.filters?.allowedItems || []) {
        if (!idToBit.has(item.id)) {
          idToBit.set(item.id, items.length);
          items.push(item);
        }
        if (item.properties?.slots) walk(item.properties.slots);
      }
    }
  };
  walk(weapon?.properties?.slots);

  const total = items.length;
  const words = Math.max(1, Math.ceil(total / 32));
  const masks = new Array(total);
  for (let i = 0; i < total; i++) masks[i] = new Uint32Array(words);

  for (const item of items) {
    const myBit = idToBit.get(item.id);
    for (const c of item.conflictingItems || []) {
      const otherBit = idToBit.get(c.id);
      if (otherBit === undefined) continue;
      masks[myBit][otherBit >> 5] |= (1 << (otherBit & 31));
    }
  }

  const compiled = { idToBit, items, total, words, masks };
  weaponCompileCache.set(weapon, compiled);
  return compiled;
}

// ---- "custom" dual-floor optimizer ----
//
// score = totalErgo + totalRecoil - PENALTY * (eDeficit + rDeficit)
// where eDeficit = max(0, eTarget - totalErgo) and similarly for r.
//
// When BOTH floors are met, deficits are zero and the optimizer
// maximizes the unconstrained sum (more slack = better build). When
// either floor is unreachable, the penalty pushes the optimizer to
// close whichever deficit is larger, returning the closest-feasible
// build instead of refusing to optimize.

function optimizeCustom(weapon, ctx, eTarget, rTarget, seedMods = null) {
  const compiled = compileWeapon(weapon);
  const WORDS = compiled.words;
  const baseErgo = weapon?.properties?.ergonomics || 0;
  const eTargetMod = Math.max(0, eTarget - baseErgo);
  const rTargetMod = Math.max(0, rTarget);
  const topSlots = weapon?.properties?.slots || [];
  const PENALTY = CUSTOM_INFEASIBILITY_PENALTY;

  const rCtx = { ...ctx, mode: "recoil", ubCache: new Map() };
  const eCtx = { ...ctx, mode: "ergo", ubCache: new Map() };
  const cCtx = { ...ctx, mode: "ergoplusrecoil", ubCache: new Map() };

  // Build initial stack with cached UBs and bit info per entry. Keys
  // computed once here instead of recomputed via string concat + Map
  // lookup at every DFS push/pop.
  const buildStackEntry = (slot, pathPrefix) => {
    const path = pathPrefix ? `${pathPrefix}.${slot.nameId}` : slot.nameId;
    return {
      slot,
      pathPrefix,
      path,
      ubR: ubForSlot(slot, path, rCtx),
      ubE: ubForSlot(slot, path, eCtx),
      ubC: ubForSlot(slot, path, cCtx),
      forced: isForced(path, slot, ctx),
    };
  };

  const stack = [];
  for (const s of topSlots) {
    if (!(s?.filters?.allowedItems?.length > 0)) continue;
    stack.push(buildStackEntry(s, ""));
  }
  // LIFO: forced first (popped first), then largest-combined-UB.
  stack.sort((a, b) => {
    if (a.forced !== b.forced) return a.forced ? 1 : -1;
    return a.ubC - b.ubC;
  });

  let restR = 0;
  let restE = 0;
  let restC = 0;
  for (const e of stack) {
    restR += e.ubR;
    restE += e.ubE;
    restC += e.ubC;
  }

  // Mutable closure state — updated in place during DFS, undone on
  // backtrack. Eliminates the per-recursion-frame Set allocation and
  // object spread that were dominating CPU on conflict-heavy weapons.
  const chosenMask = new Uint32Array(WORDS);
  const conflictMask = new Uint32Array(WORDS);
  const curMods = {};
  const curPicked = [];

  let best = {
    combined: -Infinity,
    score: 0,
    mods: {},
    picked: [],
    totalRecoil: 0,
    totalErgo: baseErgo,
    feasible: false,
  };

  function combinedScore(curR, curE) {
    const score = curR + curE;
    const eDef = Math.max(0, eTargetMod - curE);
    const rDef = Math.max(0, rTargetMod - curR);
    return score - PENALTY * (eDef + rDef);
  }

  if (seedMods) {
    const seedE = computeTotalErgo(weapon, seedMods) - baseErgo;
    const seedR = computeTotalRecoil(weapon, seedMods);
    const seedCombined = combinedScore(seedR, seedE);
    if (seedCombined > best.combined) {
      best = {
        combined: seedCombined,
        score: seedR + seedE,
        mods: { ...seedMods },
        picked: [],
        totalRecoil: seedR,
        totalErgo: baseErgo + seedE,
        feasible: seedE >= eTargetMod && seedR >= rTargetMod,
      };
    }
  }

  function combinedUB(curR, curE) {
    const score = curR + curE + restC;
    const eDefLB = Math.max(0, eTargetMod - (curE + restE));
    const rDefLB = Math.max(0, rTargetMod - (curR + restR));
    return score - PENALTY * (eDefLB + rDefLB);
  }

  function commit(curR, curE) {
    const combined = combinedScore(curR, curE);
    if (combined > best.combined) {
      best = {
        combined,
        score: curR + curE,
        mods: { ...curMods },
        picked: [...curPicked],
        totalRecoil: curR,
        totalErgo: baseErgo + curE,
        feasible: curE >= eTargetMod && curR >= rTargetMod,
      };
    }
  }

  function isCompatibleBits(itemBit, itemMask) {
    if (itemBit < 0) return true;
    if ((conflictMask[itemBit >> 5] >> (itemBit & 31)) & 1) return false;
    if (itemMask) {
      for (let i = 0; i < WORDS; i++) {
        if (itemMask[i] & chosenMask[i]) return false;
      }
    }
    return true;
  }

  function applyItem(itemBit, itemMask) {
    const undoConflict = new Uint32Array(WORDS);
    if (itemBit >= 0) {
      chosenMask[itemBit >> 5] |= (1 << (itemBit & 31));
      if (itemMask) {
        for (let i = 0; i < WORDS; i++) {
          undoConflict[i] = itemMask[i] & ~conflictMask[i];
          conflictMask[i] |= itemMask[i];
        }
      }
    }
    return undoConflict;
  }

  function undoItem(itemBit, undoConflict) {
    if (itemBit >= 0) {
      chosenMask[itemBit >> 5] &= ~(1 << (itemBit & 31));
      for (let i = 0; i < WORDS; i++) {
        conflictMask[i] &= ~undoConflict[i];
      }
    }
  }

  // Recurse into picked item: push its sub-slots, recurse dfs, then
  // pop them. Shared helper used by both the forced and free branches.
  function withSubSlots(item, path, curR, curE) {
    const subSlots = item.properties?.slots || [];
    const pushed = [];
    for (const s of subSlots) {
      if (!(s?.filters?.allowedItems?.length > 0)) continue;
      pushed.push(buildStackEntry(s, path));
    }
    pushed.sort((a, b) => {
      if (a.forced !== b.forced) return a.forced ? 1 : -1;
      return a.ubC - b.ubC;
    });
    for (const entry of pushed) {
      stack.push(entry);
      restR += entry.ubR;
      restE += entry.ubE;
      restC += entry.ubC;
    }
    dfs(curR, curE);
    for (let j = 0; j < pushed.length; j++) {
      const entry = stack.pop();
      restR -= entry.ubR;
      restE -= entry.ubE;
      restC -= entry.ubC;
    }
  }

  function dfs(curR, curE) {
    if (combinedUB(curR, curE) <= best.combined) return;

    if (stack.length === 0) {
      commit(curR, curE);
      return;
    }

    const top = stack.pop();
    const slot = top.slot;
    const path = top.path;
    restR -= top.ubR;
    restE -= top.ubE;
    restC -= top.ubC;

    if (top.forced) {
      const mod = getForcedMod(slot, path, ctx);
      if (!mod) {
        dfs(curR, curE);
      } else {
        const itemBit = compiled.idToBit.get(mod.id);
        const bit = itemBit === undefined ? -1 : itemBit;
        const mask = bit >= 0 ? compiled.masks[bit] : null;
        if (isCompatibleBits(bit, mask)) {
          const undoConflict = applyItem(bit, mask);
          const itemR = recoilContrib(mod.properties);
          const itemE = ergoContrib(mod.properties);
          const prevModId = curMods[path];
          curMods[path] = mod.id;
          curPicked.push(mod);

          withSubSlots(mod, path, curR + itemR, curE + itemE);

          if (prevModId === undefined) delete curMods[path];
          else curMods[path] = prevModId;
          curPicked.pop();
          undoItem(bit, undoConflict);
        }
        // else: lock conflict, PRUNE this branch.
      }
      stack.push(top);
      restR += top.ubR;
      restE += top.ubE;
      restC += top.ubC;
      return;
    }

    // Skip branch (optional slot)
    if (!slot.required) {
      dfs(curR, curE);
    }

    // Pick branches — collect compatible candidates with their bit info,
    // sort by combined R+E desc.
    const items = getFilteredItems(slot, ctx);
    const compatible = [];
    for (const it of items) {
      if (ctx.isAvailable && !ctx.isAvailable(it)) continue;
      const itemBit = compiled.idToBit.get(it.id);
      const bit = itemBit === undefined ? -1 : itemBit;
      const mask = bit >= 0 ? compiled.masks[bit] : null;
      if (!isCompatibleBits(bit, mask)) continue;
      compatible.push({
        item: it,
        bit,
        mask,
        itemR: recoilContrib(it.properties),
        itemE: ergoContrib(it.properties),
      });
    }
    compatible.sort((a, b) => (b.itemR + b.itemE) - (a.itemR + a.itemE));

    for (const c of compatible) {
      const undoConflict = applyItem(c.bit, c.mask);
      const prevModId = curMods[path];
      curMods[path] = c.item.id;
      curPicked.push(c.item);

      withSubSlots(c.item, path, curR + c.itemR, curE + c.itemE);

      if (prevModId === undefined) delete curMods[path];
      else curMods[path] = prevModId;
      curPicked.pop();
      undoItem(c.bit, undoConflict);
    }

    stack.push(top);
    restR += top.ubR;
    restE += top.ubE;
    restC += top.ubC;
  }

  dfs(0, 0);
  return best.combined === -Infinity ? null : best;
}

/**
 * Optimize a weapon build.
 *
 * @param {object}   weapon  Full weapon detail (must include `conflictingItems`).
 * @param {string}   mode    "ergo" | "recoil" | "recoil-balanced" | "custom"
 * @param {object}   options
 * @param {object}   options.currentMods   { [path]: modId } — user's current picks.
 *                                         Locked/skipped paths preserve these.
 * @param {Set|Array} options.lockedPaths  Paths the optimizer must preserve.
 *                                         Locked mods participate in the conflict
 *                                         pool.
 * @param {Function} options.isAvailable   (item) => bool — filter to "what user can buy".
 * @param {number}   options.ergoTarget    "custom" only — total-ergo floor.
 * @param {number}   options.recoilTarget  "custom" only — recoil-reduction floor.
 * @param {Function} options.skipSlot      Default scope/sight/magazine regex.
 *
 * @returns {object} `{ [path]: modId }` mods map. Stats are recoverable
 *                   via `calcStats(weapon, mods)` from buildStats.js.
 */
export function optimizeBuild(weapon, mode, options = {}) {
  const {
    currentMods = {},
    lockedPaths: rawLockedPaths = EMPTY_SET,
    isAvailable = null,
    ergoTarget = null,
    recoilTarget = null,
    skipSlot = defaultSkipSlot,
  } = options;
  const lockedPaths = rawLockedPaths instanceof Set
    ? rawLockedPaths
    : new Set(rawLockedPaths || []);
  const slots = weapon?.properties?.slots || [];

  // Cache fast-path: precomputed JSON was built with default skipSlot,
  // no availability filter, and no explicit locks. Only valid when the
  // current call matches that profile and the mode is one of the three
  // precomputed modes.
  const canUseCache = !isAvailable
    && lockedPaths.size === 0
    && skipSlot === defaultSkipSlot
    && mode !== "custom";

  if (canUseCache && weapon?.id) {
    const precomputed = PRECOMPUTED_BUILDS[weapon.id]?.modes?.[mode];
    if (precomputed) {
      const result = { ...precomputed };
      // Layer in user's currentMods for skipped paths (scope/sight/mag).
      for (const [path, id] of Object.entries(currentMods)) {
        const segments = path.split(".");
        const leaf = segments[segments.length - 1];
        if (skipSlot(leaf)) {
          result[path] = id;
        }
      }
      return result;
    }
  }

  const baseCtx = {
    skipSlot,
    isAvailable,
    lockedPaths,
    currentMods,
    // Passed through to getFilteredItems so dominance can use the
    // weapon-wide reverse-conflict map.
    weapon,
  };

  let resultMods;

  if (mode === "custom") {
    // Trivially-met targets (both effective floors at 0) make CUSTOM's
    // search degenerate to "maximize R+E unconstrained" — same kind of
    // build recoil-balanced gives, but without the feasibility prune
    // to keep B&B fast. Route through recoil-balanced so a slider
    // nudge from 0 doesn't kick off a multi-second optimization.
    const baseErgoCheck = weapon?.properties?.ergonomics || 0;
    const eTargetModCheck = Math.max(0, (ergoTarget || 0) - baseErgoCheck);
    const rTargetModCheck = Math.max(0, recoilTarget || 0);
    if (eTargetModCheck === 0 && rTargetModCheck === 0) {
      return optimizeBuild(weapon, "recoil-balanced", {
        currentMods,
        lockedPaths,
        isAvailable,
        skipSlot,
      });
    }
    const ctx = { ...baseCtx };
    // Seed the CUSTOM B&B with a complete build so the score-UB prune
    // fires from turn 1. Without this, low-but-nonzero targets explode
    // the search on conflict-heavy weapons.
    //
    // We try all three precomputed scalar results (ergo, recoil,
    // balanced) and pick whichever has the highest combined score for
    // *this particular target*. For a recoil-heavy target the OPT
    // RECOIL build is typically the tightest seed; for ergo-heavy
    // targets, OPT ERGO; for middle, OPT BAL. Single-seed-only loses
    // a lot of pruning on skewed targets.
    let seedMods = null;
    if (!isAvailable && lockedPaths.size === 0 && skipSlot === defaultSkipSlot && weapon?.id) {
      const seedScoreFor = (cR, cE) => {
        const eDef = Math.max(0, eTargetModCheck - cE);
        const rDef = Math.max(0, rTargetModCheck - cR);
        return cR + cE - CUSTOM_INFEASIBILITY_PENALTY * (eDef + rDef);
      };
      let bestSeedScore = -Infinity;
      for (const seedMode of ["recoil-balanced", "ergo", "recoil"]) {
        const candidate = PRECOMPUTED_BUILDS[weapon.id]?.modes?.[seedMode];
        if (!candidate) continue;
        const cE = computeTotalErgo(weapon, candidate) - baseErgoCheck;
        const cR = computeTotalRecoil(weapon, candidate);
        const c = seedScoreFor(cR, cE);
        if (c > bestSeedScore) {
          bestSeedScore = c;
          seedMods = candidate;
        }
      }
    }
    if (!seedMods) {
      // No precomputed cache available (e.g. weapon added since last
      // bundle, or locks/availability filter prevent cache). Fall back
      // to a fast scalar recoil-balanced pass for the seed.
      const ergoCtx = { ...baseCtx, mode: "ergo", ubCache: new Map() };
      const ergoResult = optimizeSlots(slots, "", ergoCtx, EMPTY_SET, EMPTY_SET);
      const maxErgo = computeTotalErgo(weapon, ergoResult.mods);
      const balCtx = { ...baseCtx, ergoPenalty: BAL_ERGO_PENALTY };
      const targeted = optimizeTargeted(weapon, balCtx, maxErgo / 2);
      seedMods = targeted ? targeted.mods : ergoResult.mods;
    }
    const result = optimizeCustom(weapon, ctx, ergoTarget || 0, recoilTarget || 0, seedMods);
    resultMods = result ? result.mods : (seedMods || {});
  } else if (mode === "recoil-balanced") {
    const ergoCtx = { ...baseCtx, mode: "ergo", ubCache: new Map() };
    const ergoResult = optimizeSlots(slots, "", ergoCtx, EMPTY_SET, EMPTY_SET);
    const maxErgo = computeTotalErgo(weapon, ergoResult.mods);
    const target = maxErgo / 2;

    const ctx = { ...baseCtx, ergoPenalty: BAL_ERGO_PENALTY };
    const targeted = optimizeTargeted(weapon, ctx, target);
    resultMods = targeted ? targeted.mods : ergoResult.mods;
  } else {
    const ctx = { ...baseCtx, mode, ubCache: new Map() };
    resultMods = optimizeSlots(slots, "", ctx, EMPTY_SET, EMPTY_SET).mods;
  }

  const result = { ...resultMods };

  // Layer in user's currentMods for any skipped path the optimizer
  // didn't write to (e.g. a scope path that the optimizer left empty
  // because it's in the default skipSlot regex).
  for (const [path, id] of Object.entries(currentMods)) {
    const segments = path.split(".");
    const leaf = segments[segments.length - 1];
    if (skipSlot(leaf) && !(path in result)) {
      result[path] = id;
    }
  }

  return result;
}
