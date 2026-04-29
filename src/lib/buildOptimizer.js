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
function getForcedMod(slot, path, ctx) {
  const id = ctx.currentMods[path];
  if (!id) return null;
  return slot?.filters?.allowedItems?.find((i) => i.id === id) || null;
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

  const items = slot?.filters?.allowedItems || [];
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
  const items = slot?.filters?.allowedItems || [];
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

    const items = slot.filters.allowedItems;
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
  const baseErgo = weapon?.properties?.ergonomics || 0;
  const eTargetMod = Math.max(0, eTarget - baseErgo);
  const rTargetMod = Math.max(0, rTarget);
  const topSlots = weapon?.properties?.slots || [];
  const PENALTY = CUSTOM_INFEASIBILITY_PENALTY;

  const rCtx = { ...ctx, mode: "recoil", ubCache: new Map() };
  const eCtx = { ...ctx, mode: "ergo", ubCache: new Map() };

  const stack = [];
  for (const s of topSlots) {
    if (!(s?.filters?.allowedItems?.length > 0)) continue;
    stack.push({ slot: s, pathPrefix: "" });
  }
  // LIFO: forced slots popped first (end of array), then largest combined UB.
  stack.sort((a, b) => {
    const pa = a.pathPrefix ? `${a.pathPrefix}.${a.slot.nameId}` : a.slot.nameId;
    const pb = b.pathPrefix ? `${b.pathPrefix}.${b.slot.nameId}` : b.slot.nameId;
    const fa = isForced(pa, a.slot, ctx);
    const fb = isForced(pb, b.slot, ctx);
    if (fa !== fb) return fa ? 1 : -1;
    return (ubForSlot(a.slot, pa, rCtx) + ubForSlot(a.slot, pa, eCtx))
         - (ubForSlot(b.slot, pb, rCtx) + ubForSlot(b.slot, pb, eCtx));
  });

  let restR = 0;
  let restE = 0;
  for (const e of stack) {
    const p = e.pathPrefix ? `${e.pathPrefix}.${e.slot.nameId}` : e.slot.nameId;
    restR += ubForSlot(e.slot, p, rCtx);
    restE += ubForSlot(e.slot, p, eCtx);
  }

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

  // Seed: when targets are 0 (or low) the feasibility prune does
  // nothing, so the DFS would otherwise explore most of the search
  // space. A precomputed seed (any complete build) gives the DFS a
  // tight initial bound. Without this, CUSTOM at e=0 r=0 takes
  // ~7s on conflict-heavy weapons; with it, <100ms.
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
    const score = curR + curE + restR + restE;
    const eDefLB = Math.max(0, eTargetMod - (curE + restE));
    const rDefLB = Math.max(0, rTargetMod - (curR + restR));
    return score - PENALTY * (eDefLB + rDefLB);
  }

  function commit(curR, curE, curMods, curPicked) {
    const combined = combinedScore(curR, curE);
    if (combined > best.combined) {
      best = {
        combined,
        score: curR + curE,
        mods: curMods,
        picked: curPicked,
        totalRecoil: curR,
        totalErgo: baseErgo + curE,
        feasible: curE >= eTargetMod && curR >= rTargetMod,
      };
    }
  }

  function dfs(curR, curE, curMods, curPicked, curChosen, curConflicts) {
    if (combinedUB(curR, curE) <= best.combined) return;

    if (stack.length === 0) {
      commit(curR, curE, curMods, curPicked);
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
        dfs(curR, curE, curMods, curPicked, curChosen, curConflicts);
      } else if (!isCompatible(mod, curChosen, curConflicts)) {
        // Lock conflict — PRUNE.
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
          const fa = isForced(pa, a.slot, ctx);
          const fb = isForced(pb, b.slot, ctx);
          if (fa !== fb) return fa ? 1 : -1;
          return (ubForSlot(a.slot, pa, rCtx) + ubForSlot(a.slot, pa, eCtx))
               - (ubForSlot(b.slot, pb, rCtx) + ubForSlot(b.slot, pb, eCtx));
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

    const items = slot.filters.allowedItems;
    const compatible = [];
    for (const it of items) {
      if (ctx.isAvailable && !ctx.isAvailable(it)) continue;
      if (!isCompatible(it, curChosen, curConflicts)) continue;
      compatible.push(it);
    }
    // Sort by combined R+E contribution desc to surface a high-score
    // solution early and tighten bounds.
    compatible.sort((a, b) =>
      (recoilContrib(b.properties) + ergoContrib(b.properties))
      - (recoilContrib(a.properties) + ergoContrib(a.properties))
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
        return (ubForSlot(a.slot, pa, rCtx) + ubForSlot(a.slot, pa, eCtx))
             - (ubForSlot(b.slot, pb, rCtx) + ubForSlot(b.slot, pb, eCtx));
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
    // the search on conflict-heavy weapons. Precompute cache hits give
    // a free seed; with locks/availability we run a fast scalar
    // recoil-balanced pass for the seed.
    let seedMods = null;
    if (!isAvailable && lockedPaths.size === 0 && skipSlot === defaultSkipSlot && weapon?.id) {
      seedMods = PRECOMPUTED_BUILDS[weapon.id]?.modes?.["recoil-balanced"] || null;
    }
    if (!seedMods) {
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
