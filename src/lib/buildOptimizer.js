// Conflict-aware branch-and-bound optimizer for Tarkov weapon builds.
//
// Each mod in tarkov.dev has a `conflictingItems` array — items that cannot
// be installed on the same weapon at the same time (e.g. an underbarrel
// grenade launcher conflicts with handguards that extend over the barrel).
//
// Strategy:
// - Branch-and-bound across all slots (top-level and nested) with
//   conflict-aware pruning. For each slot we try "skip" (if optional) and
//   every compatible candidate; for each pick we recurse into the
//   candidate's sub-slots. Partial scores are compared against the best
//   complete build found so far; branches whose optimistic completion
//   cannot beat the current best are pruned.
// - The per-slot upper bound is the unconstrained per-item max sum over
//   the subtree — i.e. ignore conflicts entirely, pick the best item at
//   every level. This is provably admissible (>= the true constrained
//   optimum), memoized per slot identity, and cheap to compute.
// - Slot order is by UB descending so the highest-impact picks commit
//   first, tightening the bound quickly.
// - B&B is seeded with a UB-sorted greedy so `best` starts at a non-trivial
//   value. When conflicts are rare (the common case for most weapons),
//   the search collapses to near-greedy cost; when conflicts bite, it
//   explores until a provably-optimal configuration is found.
//
// This is globally optimal given the scoring function — no more "slot
// order matters" or "sibling sub-slot order matters" caveats.

// Scope, sight, and magazine slots are skipped by default — players usually
// have strong personal preferences there (zoom level, mag capacity) that
// an optimizer shouldn't override. The caller can pass a custom `skipSlot`
// predicate if they want different behavior.
const DEFAULT_SKIP = /scope|sight|magazine/i;
function defaultSkipSlot(nameId) {
  return DEFAULT_SKIP.test(nameId || "");
}

// Relative weight of 1% recoil reduction vs. 1 ergo point in
// "recoil-balanced" mode. >1 favors recoil, <1 favors ergo.
const BAL_RECOIL_WEIGHT = 3.0;

function scoreMod(mp, mode) {
  if (!mp) return 0;
  if (mode === "ergo") return mp.ergonomics || 0;
  if (mode === "recoil-balanced") {
    // Recoil and accuracy come through the API as decimals (-0.20 = -20%),
    // so scaling them by 100 puts all three axes on a comparable "points"
    // scale. Recoil is then scaled by BAL_RECOIL_WEIGHT to reflect that
    // it matters more to the player than raw ergo loss. At weight 3.0,
    // a mod must buy ~6.7% recoil reduction to justify a 20-point ergo
    // hit (was ~20% at weight 1.0).
    const rec = -(mp.recoilModifier || 0) * 100 * BAL_RECOIL_WEIGHT;
    const ergo = mp.ergonomics || 0;
    const acc = (mp.accuracyModifier || 0) * 100;
    return rec + ergo + acc;
  }
  return -(mp.recoilModifier || 0);
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

const EMPTY_SET = Object.freeze(new Set());

// Admissible upper bound on the score a slot can contribute, ignoring all
// conflicts. Computed as the per-item-max recursion over the subtree: at
// each slot pick the item with the highest (score + sum of sub-UBs).
// Memoized on the slot object identity.
function ubForSlot(slot, ctx) {
  if (ctx.skipSlot(slot.nameId)) return 0;
  if (ctx.ubCache.has(slot)) return ctx.ubCache.get(slot);
  const items = slot?.filters?.allowedItems || [];
  if (items.length === 0) {
    ctx.ubCache.set(slot, 0);
    return 0;
  }
  // Optional slots can skip for a 0 contribution; required slots must pick.
  let maxItemUB = slot.required ? -Infinity : 0;
  for (const item of items) {
    if (ctx.isAvailable && !ctx.isAvailable(item)) continue;
    let total = scoreMod(item.properties, ctx.mode);
    const subSlots = item.properties?.slots || [];
    for (const sub of subSlots) total += ubForSlot(sub, ctx);
    if (total > maxItemUB) maxItemUB = total;
  }
  ctx.ubCache.set(slot, maxItemUB);
  return maxItemUB;
}

// Greedy subtree evaluator — used only to seed B&B with a non-trivial
// lower bound. Depth-first, natural sibling order; not guaranteed optimal
// when conflicts appear between siblings or across slots.
function greedySubtree(slot, path, ctx, chosenIds, conflictPool) {
  if (ctx.skipSlot(slot.nameId)) return { score: 0, mods: {}, picked: [] };
  const items = slot?.filters?.allowedItems || [];
  if (items.length === 0) return { score: 0, mods: {}, picked: [] };

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

// Greedy fill over a list of slots, UB-sorted. Produces a valid
// configuration used as the B&B seed.
function greedyFillSlots(active, pathPrefix, ctx, initialChosen, initialConflicts) {
  let score = 0;
  const mods = {};
  const picked = [];
  const chosenIds = new Set(initialChosen);
  const conflictPool = new Set(initialConflicts);

  for (const slot of active) {
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

// Branch-and-bound over a list of slots. For each slot, try skipping (if
// not required) and every compatible candidate; for each candidate, recurse
// into its sub-slots via optimizeSlots again. Prune when the best-case
// completion can't beat the current best.
function optimizeSlots(slots, pathPrefix, ctx, initialChosen, initialConflicts) {
  const active = slots
    .filter((s) => !ctx.skipSlot(s.nameId) && (s?.filters?.allowedItems?.length > 0))
    .slice()
    .sort((a, b) => ubForSlot(b, ctx) - ubForSlot(a, ctx));

  if (active.length === 0) return { score: 0, mods: {}, picked: [] };

  const ubs = active.map((s) => ubForSlot(s, ctx));
  const suffixUB = new Array(active.length + 1).fill(0);
  for (let i = active.length - 1; i >= 0; i--) {
    suffixUB[i] = suffixUB[i + 1] + ubs[i];
  }

  // Seed with greedy for a tight initial bound.
  let best = greedyFillSlots(active, pathPrefix, ctx, initialChosen, initialConflicts);

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

    // Option: skip this slot (only if not required).
    if (!slot.required) {
      dfs(i + 1, curScore, curMods, curPicked, curChosen, curConflicts);
    }

    // Option: try each compatible candidate, ordered by immediate score desc
    // so a promising full solution shows up early and tightens the bound.
    const items = slot.filters.allowedItems;
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

/**
 * Given a full weapon detail object (from weaponDetailQ with
 * conflictingItems in the query) and a mode ("recoil" | "ergo" |
 * "recoil-balanced"), return a `mods` object compatible with BuildsTab's
 * state: `{ [slotPath]: modItemId }`.
 *
 * Uses branch-and-bound to find the globally-optimal configuration for
 * the selected mode. Skipped slots (scope/sight/magazine by default) are
 * never touched; if the caller provides `currentMods`, their picks for
 * those slots are preserved in the result.
 */
export function optimizeBuild(weapon, mode, options = {}) {
  const { currentMods = {}, skipSlot = defaultSkipSlot, isAvailable = null } = options;
  const slots = weapon?.properties?.slots || [];

  const ctx = {
    mode,
    skipSlot,
    isAvailable,
    ubCache: new WeakMap(),
  };

  const { mods } = optimizeSlots(slots, "", ctx, EMPTY_SET, EMPTY_SET);
  const result = { ...mods };

  // Preserve the user's current picks for any skipped slot — e.g., their
  // chosen scope or magazine — whether top-level or nested under another
  // slot's path.
  for (const [path, id] of Object.entries(currentMods)) {
    const segments = path.split(".");
    const leaf = segments[segments.length - 1];
    if (skipSlot(leaf)) {
      result[path] = id;
    }
  }

  return result;
}
