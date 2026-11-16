"use strict";

function createOptimizer(missionData) {
  const limits = Object.freeze({ timeMs: 5000, nodes: 150000, candidates: 5000, targets: 60 });
  class LimitReached extends Error {}

  function run(data, indexes, filters, options = {}, progress = () => {}) {
    const timeMs = options.timeMs ?? limits.timeMs;
    const maxNodes = options.maxNodes ?? limits.nodes;
    const maxCandidates = options.maxCandidates ?? limits.candidates;
    const maxTargets = options.maxTargets ?? limits.targets;
    for (const [value, maximum] of [[timeMs, limits.timeMs], [maxNodes, limits.nodes],
      [maxCandidates, limits.candidates], [maxTargets, limits.targets]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid optimizer limit.");
    }
    const minimizeExpenditure = options.minimizeExpenditure !== false;
    const minimizeShooters = options.minimizeShooters === true;
    const now = options.now || (() => performance.now());
    const started = now();
    let nodes = 0, inputCount = 0, retainedCount = 0, best = [], bestCost = 0, bestShooters = 0;
    let poolComplete = false, preprocessingComplete = false;
    const audit = [];
    const checkpoint = () => {
      if (now() - started >= timeMs) throw new LimitReached("Wall-clock budget reached");
    };
    const allocations = candidate => candidate.kind === "standard"
      ? [[candidate.shooterPlatform, candidate.requiredQuantity]]
      : [[candidate.shooterAPlatform, candidate.shooterAAllocatedQuantity],
        [candidate.shooterBPlatform, candidate.shooterBAllocatedQuantity]];
    const resourceKey = (platform, weapon) => JSON.stringify([platform, weapon]);
    const snapshot = (status, reason = "") => ({
      status, reason, runtimeMs: Math.max(0, now() - started), nodes, inputCount, retainedCount,
      poolComplete, preprocessingComplete, selected: best.slice(), expenditure: bestCost, shooters: bestShooters, audit: audit.slice()
    });
    const report = phase => progress({ phase, ...snapshot("searching") });
    try {
      report("Generating qualifying candidates");
      const candidates = [];
      const collect = candidate => {
        checkpoint();
        if (candidates.length >= maxCandidates) throw new LimitReached("Candidate pool limit reached");
        candidates.push(candidate);
        inputCount = candidates.length;
      };
      missionData.summarizeEngagements(data, indexes, filters, { standard: collect, hybrid: collect }, checkpoint);
      poolComplete = true;
      const groups = new Map(), seen = new Map();
      for (const candidate of candidates) {
        checkpoint();
        if (seen.has(candidate.id)) {
          if (JSON.stringify(seen.get(candidate.id)) !== JSON.stringify(candidate)) {
            throw new Error(`Conflicting duplicate candidate ID: ${candidate.id}`);
          }
          audit.push({ id: candidate.id, reason: "Duplicate candidate", retainedId: candidate.id });
          continue;
        }
        seen.set(candidate.id, candidate);
        const usage = new Map(allocations(candidate).map(([platform, quantity]) =>
          [resourceKey(platform, candidate.weapon), quantity]));
        const item = { candidate, usage, allocations: allocations(candidate), cost: candidate.requiredQuantity };
        if (!groups.has(candidate.targetPlatform)) groups.set(candidate.targetPlatform, []);
        groups.get(candidate.targetPlatform).push(item);
      }
      if (groups.size > maxTargets) throw new LimitReached("Target limit reached");
      report("Pruning dominated candidates");
      const targets = [];
      const dominators = new Map();
      for (const [target, group] of groups) {
        group.sort((a, b) => a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0);
        const retained = [];
        for (const item of group) {
          let dominator = null;
          for (const other of group) {
            checkpoint();
            if (other === item || other.cost > item.cost) continue;
            let noMore = true, strictlyLess = other.cost < item.cost;
            for (const [key, quantity] of other.usage) {
              if (quantity > (item.usage.get(key) || 0)) { noMore = false; break; }
            }
            if (!noMore) continue;
            for (const [key, quantity] of item.usage) {
              if ((other.usage.get(key) || 0) < quantity) strictlyLess = true;
            }
            if (strictlyLess || other.candidate.id < item.candidate.id) {
              dominator = other;
              break;
            }
          }
          if (dominator) {
            dominators.set(item.candidate.id, dominator.candidate.id);
            audit.push({ id: item.candidate.id, retainedId: dominator.candidate.id,
              reason: "Same target; no greater expenditure or use of any shooter-weapon resource" });
          } else retained.push(item);
        }
        retained.sort((a, b) => a.cost - b.cost || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
        retainedCount += retained.length;
        targets.push({ target, candidates: retained });
      }
      for (const entry of audit) {
        while (dominators.has(entry.retainedId)) entry.retainedId = dominators.get(entry.retainedId);
      }
      preprocessingComplete = true;
      targets.sort((a, b) => a.candidates.length - b.candidates.length ||
        (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
      report("Searching");
      if (!targets.length) return snapshot("no feasible solution", "No qualifying engagements under the active filters");

      const available = new Map(), used = new Map(), shooters = new Map(), selected = [];
      for (const [platform, weapons] of indexes.inventoryByPlatformAndWeapon) {
        for (const [weapon, loaded] of weapons) {
          available.set(resourceKey(platform, weapon), Math.max(0, loaded - filters.minimumReserveByWeapon));
        }
      }
      let cost = 0;
      const fits = item => [...item.usage].every(([key, quantity]) =>
        quantity <= (available.get(key) || 0) - (used.get(key) || 0));
      function apply(item, sign) {
        for (const [key, quantity] of item.usage) used.set(key, (used.get(key) || 0) + sign * quantity);
        for (const [platform] of item.allocations) {
          const count = (shooters.get(platform) || 0) + sign;
          if (count) shooters.set(platform, count); else shooters.delete(platform);
        }
        cost += sign * item.cost;
        if (!Number.isSafeInteger(cost)) throw new Error("Total optimizer expenditure exceeds the safe integer limit.");
      }
      function consider() {
        const better = selected.length > best.length ||
          (selected.length === best.length && minimizeExpenditure && cost < bestCost) ||
          (selected.length === best.length && (!minimizeExpenditure || cost === bestCost) &&
            minimizeShooters && shooters.size < bestShooters);
        if (better) {
          best = selected.map(item => item.candidate);
          bestCost = cost;
          bestShooters = shooters.size;
          report("Searching");
        }
      }
      for (const target of targets) {
        checkpoint();
        const item = target.candidates.find(fits);
        if (item) { apply(item, 1); selected.push(item); }
      }
      consider();
      while (selected.length) apply(selected.pop(), -1);

      function search(index) {
        checkpoint();
        if (nodes >= maxNodes) throw new LimitReached("Search-node budget reached");
        nodes++;
        if (nodes % 1000 === 0) report("Searching");
        const possible = selected.length + targets.length - index;
        if (possible < best.length ||
            (possible === best.length && minimizeExpenditure && cost > bestCost) ||
            (possible === best.length && !minimizeExpenditure && !minimizeShooters && best.length)) return;
        if (index === targets.length) { consider(); return; }
        for (const item of targets[index].candidates) {
          checkpoint();
          if (!fits(item)) continue;
          apply(item, 1);
          selected.push(item);
          search(index + 1);
          selected.pop();
          apply(item, -1);
        }
        search(index + 1);
      }
      search(0);
      checkpoint();
      return snapshot(best.length ? "optimal" : "no feasible solution");
    } catch (error) {
      if (!(error instanceof LimitReached)) throw error;
      return snapshot(best.length ? "feasible but not proven optimal" : "limit reached", error.message);
    }
  }
  return { run, limits };
}

function optimizerWorkerMain() {
  const missionData = createMissionData();
  const optimizer = createOptimizer(missionData);
  self.onmessage = event => {
    try {
      const { data, filters, options } = event.data;
      const validated = missionData.validateAndNormalize(data);
      if (validated.errors.length) throw new Error(validated.errors.join(" "));
      const result = optimizer.run(validated.data, validated.indexes, filters, options,
        update => self.postMessage({ type: "progress", update }));
      if (result.selected.length) {
        const mission = missionData.createMissionPackage(validated.data, filters, result.selected, false);
        if (!missionData.evaluateMission(validated.data, validated.indexes, mission).feasible) {
          throw new Error("Optimizer proposal failed independent mission validation.");
        }
      }
      self.postMessage({ type: "result", result });
    } catch (error) {
      self.postMessage({ type: "error", message: error.message });
    }
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createOptimizer, optimizerWorkerMain };
