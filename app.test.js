"use strict";

// Run with: node --test app.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { Worker: ThreadWorker } = require("node:worker_threads");
const { createOptimizer } = require("./optimizer.js");
const { validateAndNormalize, distanceMeters, defaultFilters, summarizeEngagements, generateCandidates,
  diagnosePair, filterAndSortCandidates, candidatesCsv, exportPackage, createMissionPackage,
  validateMissionPackage, evaluateMission } = require("./app.js");

function fixture() {
  return {
    platforms: [{
      platform_name: "ship", side: "blue", group: "group", subgroups: ["sub"],
      latitude: "45.5", longitude: "-90", altitude: "12",
      category: "surface", weapons: [{ name: "missile", quantity: "3" }],
      sensors: [], type: "ship-type"
    }],
    weapons: [{ weapon_name: "missile", side: "blue", weapon_min_range: "0", weapon_max_range: "1000" }],
    lethality: [{ weapon: "missile", platformType: "ship-type", quantity: "2" }]
  };
}

test("normalizes data without mutating sources and creates all indexes", () => {
  const input = fixture();
  const result = validateAndNormalize(input);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  const platform = result.data.platforms[0];
  assert.equal(platform.latitude, 45.5);
  assert.equal(platform.longitude, -90);
  assert.equal(platform.altitude, 12);
  assert.equal(platform.weapons[0].quantity, 3);
  assert.equal(result.data.weapons[0].weapon_max_range, 1000);
  assert.equal(result.data.lethality[0].quantity, 2);
  assert.equal(input.platforms[0].latitude, "45.5");
  assert.equal(input.platforms[0].weapons[0].quantity, "3");
  assert.equal(result.indexes.platformByName.get("ship"), platform);
  assert.equal(result.indexes.weaponByName.get("missile"), result.data.weapons[0]);
  assert.equal(result.indexes.lethalityByWeaponAndTargetType.get("missile").get("ship-type").quantity, 2);
  assert.equal(result.indexes.inventoryByPlatformAndWeapon.get("ship").get("missile"), 3);
  assert.deepEqual(result.indexes.platformsBySide.get("blue"), [platform]);
});

test("rejects missing arrays, malformed records and ambiguous duplicate keys", () => {
  const missing = validateAndNormalize({ platforms: null, weapons: {}, lethality: undefined });
  assert.equal(missing.errors.length, 3);
  assert.equal(missing.data, null);
  assert.equal(missing.indexes, null);

  const input = fixture();
  input.platforms.push({ ...input.platforms[0] }, null);
  input.platforms[0].weapons.push({ name: "missile", quantity: 1 });
  input.weapons.push({ ...input.weapons[0] }, "bad");
  input.lethality.push({ ...input.lethality[0] }, []);
  const result = validateAndNormalize(input);
  assert.equal(result.indexes, null);
  for (const fragment of ["Platform name", "weapon \"missile\"", "Weapon name", "Lethality key", "must be an object"]) {
    assert.ok(result.errors.some(error => error.includes(fragment)), fragment);
  }

  const sparse = fixture();
  sparse.platforms[0].sensors = Array(1);
  sparse.platforms[0].weapons = Array(1);
  sparse.weapons = Array(1);
  sparse.lethality = Array(1);
  const sparseResult = validateAndNormalize(sparse);
  assert.equal(sparseResult.errors.length, 4);
  assert.equal(sparseResult.indexes, null);
});

test("rejects invalid numbers, missing fields, and reversed ranges", () => {
  const input = fixture();
  input.platforms[0].latitude = "91";
  input.platforms[0].longitude = -181;
  input.platforms[0].altitude = "";
  input.platforms[0].side = "";
  input.platforms[0].subgroups = null;
  input.platforms[0].weapons[0].quantity = -1;
  input.weapons[0].weapon_min_range = 10;
  input.weapons[0].weapon_max_range = 5;
  input.lethality[0].quantity = 0;
  const result = validateAndNormalize(input);
  for (const fragment of ["latitude", "longitude", "altitude", ".side", "subgroups", "weapons[0].quantity", "minimum range", "lethality[0].quantity"]) {
    assert.ok(result.errors.some(error => error.includes(fragment)), fragment);
  }
  for (const value of ["not a number", Infinity, null, true, "1.5", Number.MAX_SAFE_INTEGER + 1]) {
    const example = fixture();
    example.platforms[0].weapons[0].quantity = value;
    assert.ok(validateAndNormalize(example).errors.length, String(value));
  }
  const bounds = fixture();
  bounds.platforms[0].latitude = -90;
  bounds.platforms[0].longitude = 180;
  bounds.platforms[0].weapons[0].quantity = 0;
  assert.deepEqual(validateAndNormalize(bounds).errors, []);
});

test("reports each cross-reference warning without rejecting valid data", () => {
  const input = fixture();
  input.platforms[0].weapons.push({ name: "missing", quantity: 1 });
  input.lethality.push({ weapon: "undefined", platformType: "other", quantity: 1 });
  input.platforms[0].type = "uncovered";
  const result = validateAndNormalize(input);
  assert.deepEqual(result.errors, []);
  for (const fragment of ["missing\" has no weapon definition", "missing\" has no lethality", "undefined weapon", "uncovered\" has no applicable"]) {
    assert.ok(result.warnings.some(warning => warning.includes(fragment)), fragment);
  }
});

test("calculates great-circle distance in meters, ignoring altitude", () => {
  const origin = { latitude: 0, longitude: 0, altitude: 0 };
  assert.equal(distanceMeters(origin, { ...origin, altitude: 10000 }), 0);
  assert.ok(Math.abs(distanceMeters(origin, { latitude: 0, longitude: 1 }) - 111195) < 1);
  assert.ok(Math.abs(distanceMeters(origin, { latitude: 0, longitude: 180 }) - 20015087) < 1);
});

function engagementFixture() {
  const input = fixture();
  const shooter = input.platforms[0];
  shooter.latitude = 0;
  shooter.longitude = 0;
  shooter.weapons[0].quantity = 2;
  input.platforms.push(
    { ...shooter, platform_name: "ship2", group: "other", subgroups: ["other-sub"], weapons: [{ name: "missile", quantity: 2 }] },
    { ...shooter, platform_name: "target", side: "red", group: "red-group", type: "target-type", weapons: [] }
  );
  input.lethality[0].platformType = "target-type";
  input.lethality[0].quantity = 3;
  return validateAndNormalize(input);
}

test("supplied data meets phase 1 regression counts", () => {
  const context = {};
  for (const file of ["platform_details.js", "weapon_details.js", "weapon_lethality_details.js"]) {
    vm.runInNewContext(fs.readFileSync(file, "utf8"), context);
  }
  const result = validateAndNormalize({
    platforms: context.PLATFORM_DATA, weapons: context.WEAPON_DATA, lethality: context.WEAPON_LETHALITY_DATA
  });
  const summary = summarizeEngagements(result.data, result.indexes, defaultFilters());
  assert.deepEqual(
    [summary.shooterCount, summary.targetCount, summary.pairCount, summary.lethalityMatches,
      summary.rangeQualified, summary.standardCandidates, summary.hybridPatterns, summary.eligibleTargets],
    [10, 15, 150, 330, 328, 260, 2287, 15]
  );
  for (const map of [summary.byWeapon, summary.byTargetType, summary.byShooterGroup, summary.byTargetGroup]) {
    assert.equal([...map.values()].reduce((sum, value) => sum + value, 0), 260);
  }
  const standard = generateCandidates(result.data, result.indexes, defaultFilters(), "standard");
  const hybrid = generateCandidates(result.data, result.indexes, defaultFilters(), "hybrid");
  assert.equal(standard.length, 260);
  assert.equal(hybrid.length, 2287);
  assert.equal(new Set(standard.map(c => c.id)).size, 260);
  assert.equal(new Set(hybrid.map(c => c.id)).size, 2287);
  assert.ok(hybrid.every(c => c.shooterAPlatform < c.shooterBPlatform &&
    c.shooterAAllocatedQuantity > 0 && c.shooterBAllocatedQuantity > 0 &&
    c.shooterAAllocatedQuantity + c.shooterBAllocatedQuantity === c.requiredQuantity));
});

test("candidate details reconcile with filtered counts and IDs survive shooter reordering", () => {
  const result = engagementFixture();
  result.data.platforms[0].weapons[0].quantity = 4;
  const filters = defaultFilters();
  filters.minimumReserveByWeapon = 1;
  const summary = summarizeEngagements(result.data, result.indexes, filters);
  const standard = generateCandidates(result.data, result.indexes, filters, "standard");
  const hybrids = generateCandidates(result.data, result.indexes, filters, "hybrid");
  assert.equal(standard.length, summary.standardCandidates);
  assert.equal(hybrids.length, summary.hybridPatterns);
  assert.deepEqual([standard[0].shooterLoadedQuantity, standard[0].shooterReserveQuantity, standard[0].shooterAvailableQuantity], [4, 1, 3]);
  assert.equal(hybrids.length, 1);
  assert.deepEqual([hybrids[0].shooterAPlatform, hybrids[0].shooterBPlatform,
    hybrids[0].shooterAAllocatedQuantity, hybrids[0].shooterBAllocatedQuantity], ["ship", "ship2", 2, 1]);
  result.indexes.platformsBySide.get("blue").reverse();
  assert.deepEqual(generateCandidates(result.data, result.indexes, filters, "hybrid").map(c => c.id), hybrids.map(c => c.id));
  filters.weaponNames = ["no-such-weapon"];
  assert.equal(generateCandidates(result.data, result.indexes, filters, "standard").length, 0);
  assert.equal(generateCandidates(result.data, result.indexes, filters, "hybrid").length, 0);
});

test("pair diagnostics report filter, missing data, range, inventory and reserve failures", () => {
  const result = engagementFixture();
  const filters = defaultFilters();
  assert.match(diagnosePair(result.indexes, filters, "ship", "target", "missile").failures.join(" "), /Insufficient/);
  filters.minimumReserveByWeapon = 2;
  result.data.platforms[0].weapons[0].quantity = 3;
  assert.match(diagnosePair(result.indexes, filters, "ship", "target", "missile").failures.join(" "), /Reserve/);
  filters.shooterGroups = ["other"];
  filters.targetTypes = ["other"];
  result.data.weapons[0].weapon_min_range = 1;
  const failures = diagnosePair(result.indexes, filters, "ship", "target", "missile").failures.join(" ");
  assert.match(failures, /Shooter excluded/);
  assert.match(failures, /Target excluded/);
  assert.match(failures, /below minimum/);
  result.data.weapons[0].weapon_min_range = 0;
  result.data.weapons[0].weapon_max_range = 0;
  result.data.platforms[2].longitude = 1;
  assert.match(diagnosePair(result.indexes, filters, "ship", "target", "missile").failures.join(" "), /beyond maximum/);
  const missing = diagnosePair(result.indexes, filters, "ship", "target", "missing").failures.join(" ");
  assert.match(missing, /does not carry/);
  assert.match(missing, /missing from weapon definitions/);
  assert.match(missing, /No lethality/);
});

test("search, sorting, CSV escaping and JSON export preserve filtered records and metadata", () => {
  const result = engagementFixture();
  result.data.platforms[0].weapons[0].quantity = 3;
  const filters = defaultFilters();
  const summary = summarizeEngagements(result.data, result.indexes, filters);
  const records = generateCandidates(result.data, result.indexes, filters, "standard");
  assert.equal(filterAndSortCandidates(records, "SHIP", "target").length, 1);
  assert.equal(filterAndSortCandidates(records, "absent", "weapon").length, 0);
  const csv = candidatesCsv([{ id: 'a,"b', weapon: "=formula", quantity: -1 }]);
  assert.match(csv, /"a,""b"/);
  assert.match(csv, /"'=formula"/);
  assert.match(csv, /"-1"/);
  assert.match(candidatesCsv([], "standard"), /"shooterPlatform"/);
  const exported = JSON.parse(JSON.stringify(exportPackage(filters, summary, { standard: records, hybrid: [] }, { search: "", sort: "weapon" }, "2026-01-01T00:00:00.000Z")));
  assert.equal(exported.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(exported.scenarioRules.rangeUnit, "meters");
  assert.equal(exported.summary.standardCandidates, 1);
  assert.equal(exported.summary.byWeapon.missile, 1);
  assert.equal(exported.candidates.standard[0].id, records[0].id);
});

test("mission aggregates standard and hybrid allocations and flags shared inventory and duplicate targets", () => {
  const input = fixture();
  input.platforms[0].latitude = 0;
  input.platforms[0].longitude = 0;
  input.platforms[0].weapons[0].quantity = 5;
  input.platforms.push(
    { ...input.platforms[0], platform_name: "ship2", weapons: [{ name: "missile", quantity: 3 }] },
    { ...input.platforms[0], platform_name: "target1", side: "red", type: "target-type", weapons: [] },
    { ...input.platforms[0], platform_name: "target2", side: "red", type: "target-type", weapons: [] }
  );
  input.lethality[0].platformType = "target-type";
  input.lethality[0].quantity = 3;
  const { data, indexes } = validateAndNormalize(input);
  const filters = defaultFilters();
  filters.minimumReserveByWeapon = 1;
  const standard = generateCandidates(data, indexes, filters, "standard").find(c => c.targetPlatform === "target1");
  const hybrid = generateCandidates(data, indexes, filters, "hybrid").find(c =>
    c.targetPlatform === "target2" && c.shooterAAllocatedQuantity === 2);
  const mission = createMissionPackage(data, filters, [standard, hybrid], false);
  let result = evaluateMission(data, indexes, mission);
  assert.deepEqual([result.selectedCount, result.targetCount, result.standardCount, result.hybridCount], [2, 2, 1, 1]);
  assert.equal(result.expenditures.get("missile"), 6);
  assert.deepEqual(result.inventory.find(row => row.platform === "ship"), {
    platform: "ship", weapon: "missile", loaded: 5, reserve: 1, available: 4, planned: 5, remaining: -1, deficit: 1
  });
  assert.match(result.conflicts.join(" "), /available = 4; planned = 5; deficit = 1/);
  assert.equal(result.results[0].status, "conflict");
  const withoutSecondShooter = validateAndNormalize({
    ...input, platforms: input.platforms.filter(platform => platform.platform_name !== "ship2")
  });
  const missingShooter = evaluateMission(withoutSecondShooter.data, withoutSecondShooter.indexes, mission);
  assert.equal(missingShooter.results[1].status, "conflict");
  assert.match(missingShooter.conflicts.join(" "), /ship2: shooter is missing/);
  assert.equal(missingShooter.results[1].candidate.shooterBAllocatedQuantity, 1);
  mission.selectedCandidateSnapshots[1] = { ...hybrid, targetPlatform: "target1",
    id: hybrid.id.replace("target2", "target1") };
  mission.selectedCandidateIds[1] = mission.selectedCandidateSnapshots[1].id;
  assert.match(evaluateMission(data, indexes, mission).conflicts.join(" "), /only one is permitted/);
  mission.permitDuplicateTargets = true;
  result = evaluateMission(data, indexes, mission);
  assert.doesNotMatch(result.conflicts.join(" "), /only one is permitted/);
});

test("mission JSON preserves allocations, detects changed scenarios, and rejects malformed packages", () => {
  const input = fixture();
  input.platforms.push({ ...input.platforms[0], platform_name: "target", side: "red", type: "target-type", weapons: [] });
  input.lethality[0].platformType = "target-type";
  const original = validateAndNormalize(input);
  const filters = defaultFilters();
  const candidate = generateCandidates(original.data, original.indexes, filters, "standard")[0];
  const saved = JSON.parse(JSON.stringify(createMissionPackage(original.data, filters, [candidate], false)));
  assert.equal(evaluateMission(original.data, original.indexes, saved).results[0].status, "feasible");
  const minimal = { ...saved };
  delete minimal.scenarioDataFingerprint;
  delete minimal.permitDuplicateTargets;
  const restored = validateMissionPackage(minimal);
  assert.equal(restored.permitDuplicateTargets, false);
  assert.equal(evaluateMission(original.data, original.indexes, restored).scenarioChanged, true);
  input.platforms[0].weapons[0].quantity = 4;
  let changed = validateAndNormalize(input);
  let result = evaluateMission(changed.data, changed.indexes, saved);
  assert.equal(result.scenarioChanged, true);
  assert.equal(result.results[0].status, "warning");
  assert.match(result.results[0].differences.join(" "), /shooterLoadedQuantity: saved 3; current 4/);
  input.lethality[0].quantity = 3;
  changed = validateAndNormalize(input);
  result = evaluateMission(changed.data, changed.indexes, saved);
  assert.equal(result.results[0].status, "conflict");
  assert.match(result.conflicts.join(" "), /saved allocation was not replaced/);
  assert.equal(result.results[0].candidate.requiredQuantity, 2);
  input.lethality[0].quantity = 2;
  input.platforms[0].weapons[0].quantity = 1;
  changed = validateAndNormalize(input);
  result = evaluateMission(changed.data, changed.indexes, saved);
  assert.match(result.conflicts.join(" "), /saved allocation exceeds available inventory/);
  assert.equal(result.results[0].candidate.requiredQuantity, 2);
  saved.selectedCandidateSnapshots[0].requiredQuantity = -1;
  assert.throws(() => validateMissionPackage(saved), /Invalid mission candidate snapshot/);
});

function optimizerFixture() {
  const input = fixture();
  const base = input.platforms[0];
  base.latitude = 0;
  base.longitude = 0;
  base.weapons = [{ name: "A", quantity: 3 }, { name: "B", quantity: 1 }];
  input.platforms.push(
    { ...base, platform_name: "ship2", weapons: [{ name: "B", quantity: 1 }] },
    { ...base, platform_name: "target1", side: "red", type: "X", weapons: [] },
    { ...base, platform_name: "target2", side: "red", type: "Y", weapons: [] }
  );
  input.weapons = ["A", "B"].map(weapon_name => ({ weapon_name, side: "blue", weapon_min_range: 0, weapon_max_range: 1000 }));
  input.lethality = [
    { weapon: "A", platformType: "X", quantity: 2 },
    { weapon: "B", platformType: "X", quantity: 1 },
    { weapon: "A", platformType: "Y", quantity: 1 }
  ];
  return validateAndNormalize(input);
}

test("bounded optimizer finds maximum coverage and lexicographic objectives without overspending", () => {
  const { data, indexes } = optimizerFixture();
  const filters = defaultFilters();
  const optimizer = createOptimizer(require("./app.js"));
  const result = optimizer.run(data, indexes, filters, { minimizeExpenditure: true, minimizeShooters: true });
  assert.equal(result.status, "optimal");
  assert.equal(result.selected.length, 2);
  assert.equal(result.expenditure, 2);
  assert.equal(result.shooters, 1);
  assert.deepEqual(result.selected.map(c => [c.targetPlatform, c.weapon, c.shooterPlatform]).sort(),
    [["target1", "B", "ship"], ["target2", "A", "ship"]]);
  const assessment = evaluateMission(data, indexes, createMissionPackage(data, filters, result.selected, false));
  assert.equal(assessment.feasible, true);
  assert.ok(assessment.inventory.every(row => row.deficit === 0));
  const repeated = optimizer.run(data, indexes, filters, { minimizeExpenditure: true, minimizeShooters: true });
  assert.deepEqual(repeated.selected.map(c => c.id), result.selected.map(c => c.id));
});

test("optimizer reports limits and empty pools without claiming incomplete results are optimal", () => {
  const { data, indexes } = optimizerFixture();
  const optimizer = createOptimizer(require("./app.js"));
  const filters = defaultFilters();
  const limited = optimizer.run(data, indexes, filters, { maxNodes: 1 });
  assert.equal(limited.status, "feasible but not proven optimal");
  assert.match(limited.reason, /Search-node/);
  assert.equal(evaluateMission(data, indexes, createMissionPackage(data, filters, limited.selected, false)).feasible, true);
  const capped = optimizer.run(data, indexes, filters, { maxCandidates: 1 });
  assert.equal(capped.status, "limit reached");
  assert.match(capped.reason, /Candidate pool/);
  filters.weaponNames = ["no-such-weapon"];
  assert.equal(optimizer.run(data, indexes, filters).status, "no feasible solution");
  assert.throws(() => optimizer.run(data, indexes, filters, { timeMs: 5001 }), /Invalid optimizer limit/);
  let tick = 0;
  const timed = optimizer.run(data, indexes, defaultFilters(), { timeMs: 1, now: () => tick++ });
  assert.equal(timed.status, "limit reached");
  assert.match(timed.reason, /Wall-clock/);
});

test("optimizer handles pairwise hybrids and reserves as shared constraints", () => {
  const { data, indexes } = engagementFixture();
  const filters = defaultFilters();
  const optimizer = createOptimizer(require("./app.js"));
  const result = optimizer.run(data, indexes, filters);
  assert.equal(result.status, "optimal");
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].kind, "hybrid");
  assert.equal(evaluateMission(data, indexes, createMissionPackage(data, filters, result.selected, false)).feasible, true);
  filters.minimumReserveByWeapon = 1;
  assert.equal(optimizer.run(data, indexes, filters).status, "no feasible solution");
});

test("optimizer audits duplicates and resource-dominated choices without pruning tradeoffs", () => {
  const make = (id, shooterPlatform, requiredQuantity) => ({
    id, kind: "standard", shooterPlatform, targetPlatform: "target", weapon: "A", requiredQuantity
  });
  const items = [make("lower", "ship", 1), make("higher", "ship", 2),
    make("alternative", "ship2", 1), make("lower", "ship", 1)];
  const optimizer = createOptimizer({ summarizeEngagements(data, indexes, filters, collect) {
    items.forEach(item => collect.standard(item));
  } });
  const indexes = { inventoryByPlatformAndWeapon: new Map([
    ["ship", new Map([["A", 2]])], ["ship2", new Map([["A", 1]])]
  ]) };
  const result = optimizer.run({}, indexes, defaultFilters());
  assert.equal(result.status, "optimal");
  assert.equal(result.retainedCount, 2);
  assert.deepEqual(result.audit.map(item => [item.id, item.retainedId]).sort(),
    [["higher", "lower"], ["lower", "lower"]]);
});

test("optimizer agrees with an exhaustive oracle on small resource-constrained instances", () => {
  let seed = 9381;
  const random = maximum => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % maximum;
  };
  for (let trial = 0; trial < 30; trial++) {
    const groups = Array.from({ length: 4 }, (_, target) => Array.from({ length: 3 }, (_, choice) => {
      const shooter = `s${random(3)}`, weapon = `w${random(2)}`, quantity = 1 + random(3);
      return { id: `c${target}-${choice}`, kind: "standard", shooterPlatform: shooter,
        targetPlatform: `t${target}`, weapon, requiredQuantity: quantity };
    }));
    const indexes = { inventoryByPlatformAndWeapon: new Map(
      ["s0", "s1", "s2"].map(shooter => [shooter, new Map([["w0", 3], ["w1", 3]])])
    ) };
    const optimizer = createOptimizer({ summarizeEngagements(data, indexes, filters, collect) {
      groups.flat().forEach(candidate => collect.standard(candidate));
    } });
    const result = optimizer.run({}, indexes, defaultFilters(), { minimizeShooters: true });
    let best = [-1, Infinity, Infinity];
    function enumerate(index, usage, selected) {
      if (index === groups.length) {
        const score = [selected.length, selected.reduce((sum, item) => sum + item.requiredQuantity, 0),
          new Set(selected.map(item => item.shooterPlatform)).size];
        if (score[0] > best[0] || (score[0] === best[0] && (score[1] < best[1] ||
            (score[1] === best[1] && score[2] < best[2])))) best = score;
        return;
      }
      enumerate(index + 1, usage, selected);
      for (const candidate of groups[index]) {
        const key = `${candidate.shooterPlatform}/${candidate.weapon}`;
        const quantity = (usage.get(key) || 0) + candidate.requiredQuantity;
        if (quantity > 3) continue;
        const next = new Map(usage);
        next.set(key, quantity);
        enumerate(index + 1, next, [...selected, candidate]);
      }
    }
    enumerate(0, new Map(), []);
    assert.equal(result.status, "optimal");
    assert.deepEqual([result.selected.length, result.expenditure, result.shooters], best);
  }
});

test("hybrids count positive exact allocations from distinct shooters and respect reserve", () => {
  const result = engagementFixture();
  const filters = defaultFilters();
  let summary = summarizeEngagements(result.data, result.indexes, filters);
  assert.equal(summary.standardCandidates, 0);
  assert.equal(summary.hybridPatterns, 2);
  assert.equal(summary.eligibleTargets, 0);
  filters.minimumReserveByWeapon = 1;
  summary = summarizeEngagements(result.data, result.indexes, filters);
  assert.equal(summary.hybridPatterns, 0);
  filters.minimumReserveByWeapon = 0;
  result.data.platforms[0].weapons[0].quantity = 3;
  summary = summarizeEngagements(result.data, result.indexes, filters);
  assert.equal(summary.standardCandidates, 1);
  assert.equal(summary.hybridPatterns, 2);
  assert.equal(summary.eligibleTargets, 1);
  filters.includeStandardEngagements = false;
  summary = summarizeEngagements(result.data, result.indexes, filters);
  assert.equal(summary.standardCandidates, 0);
  assert.equal(summary.hybridPatterns, 2);
  filters.includeHybridEngagements = false;
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).hybridPatterns, 0);
});

test("hybrids require both shooters in range and carrying the same weapon", () => {
  const result = engagementFixture();
  const filters = defaultFilters();
  result.data.platforms[1].longitude = 1;
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).hybridPatterns, 0);
  result.data.platforms[1].longitude = 0;
  result.data.platforms[1].weapons[0].name = "different";
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).hybridPatterns, 0);
});

test("reports hybrid count overflow rather than returning an imprecise total", () => {
  const input = fixture();
  input.platforms[0].latitude = input.platforms[0].longitude = 0;
  input.platforms[0].weapons[0].quantity = Number.MAX_SAFE_INTEGER;
  input.platforms.push(
    { ...input.platforms[0], platform_name: "ship2" },
    { ...input.platforms[0], platform_name: "ship3" },
    { ...input.platforms[0], platform_name: "target", side: "red", weapons: [] }
  );
  input.lethality[0].quantity = Number.MAX_SAFE_INTEGER;
  const result = validateAndNormalize(input);
  assert.throws(() => summarizeEngagements(result.data, result.indexes, defaultFilters()), /safe integer limit/);
});

test("filters platforms, weapon, distances and inclusive weapon-range boundaries before counts", () => {
  const result = engagementFixture();
  const filters = defaultFilters();
  filters.shooterPlatformNames = ["ship"];
  filters.targetPlatformNames = ["target"];
  filters.shooterGroups = ["group"];
  filters.targetGroups = ["red-group"];
  filters.shooterSubgroups = ["sub"];
  filters.targetSubgroups = ["sub"];
  filters.shooterTypes = ["ship-type"];
  filters.targetTypes = ["target-type"];
  filters.categories = ["surface"];
  filters.weaponNames = ["missile"];
  filters.maxDistanceMeters = 0;
  let summary = summarizeEngagements(result.data, result.indexes, filters);
  assert.deepEqual([summary.shooterCount, summary.targetCount, summary.pairCount, summary.lethalityMatches, summary.rangeQualified], [1, 1, 1, 1, 1]);
  result.data.weapons[0].weapon_min_range = 1;
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).rangeQualified, 0);
  result.data.weapons[0].weapon_min_range = 0;
  result.data.weapons[0].weapon_max_range = 0;
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).rangeQualified, 1);
  result.data.platforms[2].longitude = 0.001;
  summary = summarizeEngagements(result.data, result.indexes, filters);
  assert.equal(summary.pairCount, 1);
  assert.equal(summary.distanceQualifiedPairs, 0);
  assert.equal(summary.lethalityMatches, 0);
  filters.maxDistanceMeters = null;
  filters.weaponNames = ["other"];
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).lethalityMatches, 0);
  filters.shooterGroups = ["other"];
  assert.equal(summarizeEngagements(result.data, result.indexes, filters).shooterCount, 0);
});

test("rejects invalid filter values and same-side selection", () => {
  const result = engagementFixture();
  const filters = defaultFilters();
  filters.targetSide = "blue";
  assert.throws(() => summarizeEngagements(result.data, result.indexes, filters), /different/);
  filters.targetSide = "red";
  filters.minimumReserveByWeapon = 1.5;
  assert.throws(() => summarizeEngagements(result.data, result.indexes, filters), /reserve/);
  filters.minimumReserveByWeapon = 0;
  filters.maxDistanceMeters = NaN;
  assert.throws(() => summarizeEngagements(result.data, result.indexes, filters), /distance/);
});

test("offline page validates data and proposes sortable missions without obsolete views", async () => {
  const html = fs.readFileSync("index.html", "utf8");
  const scripts = [...html.matchAll(/<script defer src="\.\/([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ["platform_details.js", "weapon_details.js", "weapon_lethality_details.js", "optimizer.js", "app.js"]);
  assert.doesNotMatch(html, /(?:https?:)?\/\//);
  for (const id of ["results", "inspection", "mission"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  const pageIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));

  function runPage(sourceFiles) {
    const elements = new Map();
    const downloads = [];
    const workers = [];
    function element() {
      return {
        children: [], events: {},
        append(...children) { this.children.push(...children); },
        replaceChildren() { this.children = []; },
        addEventListener(name, callback) { this.events[name] = callback; },
        click() { this.events.click?.(); }
      };
    }
    const formControls = {};
    for (const name of ["shooterSide", "targetSide", "shooterPlatformNames", "targetPlatformNames",
      "shooterGroups", "targetGroups", "shooterSubgroups", "targetSubgroups", "shooterTypes",
      "targetTypes", "weaponNames", "categories"]) {
      formControls[name] = {
        multiple: !name.endsWith("Side"), children: [],
        append(option) { this.children.push(option); },
        get selectedOptions() { return this.children.filter(option => option.selected); },
        get value() { return this.children.find(option => option.selected)?.value || ""; },
        set value(value) { for (const option of this.children) option.selected = option.value === value; }
      };
    }
    const numberControl = initial => ({
      value: initial,
      get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); },
      set valueAsNumber(value) { this.value = String(value); }
    });
    formControls.maxDistanceMeters = numberControl("");
    formControls.minimumReserveByWeapon = numberControl("0");
    formControls.includeStandardEngagements = { checked: true };
    formControls.includeHybridEngagements = { checked: true };
    const form = {
      elements: formControls,
      addEventListener(name, callback) { this.callback = callback; },
      requestSubmit() { this.callback({ preventDefault() {} }); }
    };
    const document = {
      getElementById(id) {
        if (id === "filters") return form;
        if (!pageIds.has(id)) return null;
        if (!elements.has(id)) {
          const item = element();
          if (id === "optimizer-sort") item.value = "target";
          elements.set(id, item);
        }
        return elements.get(id);
      },
      createElement(tag) {
        const item = element();
        if (tag === "a") item.click = () => downloads.push({ name: item.download, blob: blobs.get(item.href) });
        return item;
      }
    };
    const blobs = new Map();
    class FakeWorker {
      constructor(url) { this.blob = blobs.get(url); workers.push(this); }
      postMessage(message) { this.message = message; }
      terminate() { this.terminated = true; }
    }
    const context = vm.createContext({
      document, Blob, Worker: FakeWorker,
      URL: { createObjectURL(blob) { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL() {} },
      setTimeout(callback, delay) { if (!delay) callback(); return 1; },
      clearTimeout() {}
    });
    context.window = context;
    for (const file of sourceFiles) vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    document.getElementById("optimize-expenditure").checked = true;
    document.getElementById("optimize-shooters").checked = false;
    return { elements, form, downloads, workers };
  }
  const loaded = runPage(scripts);
  assert.equal(loaded.elements.get("validation-status").textContent, "Data validated successfully.");
  assert.ok(loaded.elements.get("warnings").children.some(item => item.textContent.includes("no lethality")));
  const shooterOption = loaded.form.elements.shooterPlatformNames.children.find(option => option.value === "blue_ship_1");
  shooterOption.selected = true;
  loaded.form.requestSubmit();
  loaded.elements.get("optimize-start").click();
  const worker = loaded.workers[0];
  const workerMessages = [];
  const workerSource = await worker.blob.text();
  const workerContext = vm.createContext({
    performance, self: { postMessage(message) { workerMessages.push(message); worker.onmessage({ data: message }); } }
  });
  vm.runInContext(workerSource, workerContext);
  workerContext.self.onmessage({ data: worker.message });
  assert.match(loaded.elements.get("optimizer-status").textContent, /optimal/);
  assert.ok(loaded.elements.get("optimizer-rows").children.length > 1);
  assert.ok(loaded.elements.get("optimizer-inventory").children.length > 0);
  assert.equal(worker.terminated, true);
  const optimal = workerMessages.find(message => message.type === "result").result;
  const thread = new ThreadWorker(
    `const { parentPort } = require("node:worker_threads");
     globalThis.self = { postMessage: message => parentPort.postMessage(message) };
     ${workerSource}
     parentPort.on("message", data => self.onmessage({ data }));`, { eval: true }
  );
  try {
    const threadedResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker test timed out")), 10000);
      thread.on("message", message => {
        if (message.type === "result") { clearTimeout(timeout); resolve(message.result); }
        if (message.type === "error") { clearTimeout(timeout); reject(new Error(message.message)); }
      });
      thread.on("error", error => { clearTimeout(timeout); reject(error); });
      thread.postMessage(worker.message);
    });
    assert.equal(threadedResult.status, optimal.status);
    assert.deepEqual(threadedResult.selected.map(candidate => candidate.id), Array.from(optimal.selected, candidate => candidate.id));
  } finally {
    await thread.terminate();
  }
  for (const [sort, column] of [["target", 3], ["weapon", 4], ["shooter", 2]]) {
    loaded.elements.get("optimizer-sort").value = sort;
    loaded.elements.get("optimizer-sort").events.change();
    const values = loaded.elements.get("optimizer-rows").children.map(row => row.children[column].textContent);
    assert.deepEqual(values, values.slice().sort((a, b) => a.localeCompare(b)));
  }
  loaded.elements.get("optimizer-sort").value = "required";
  loaded.elements.get("optimizer-sort").events.change();
  const quantities = loaded.elements.get("optimizer-rows").children.map(row => {
    const allocation = row.children[5].textContent.split(" + ").map(Number);
    return allocation.reduce((sum, quantity) => sum + quantity, 0);
  });
  assert.ok(new Set(quantities).size > 1);
  assert.deepEqual(quantities, quantities.slice().sort((a, b) => a - b));
  loaded.elements.get("optimize-save").click();
  const savedProposal = JSON.parse(await loaded.downloads[0].blob.text());
  assert.deepEqual(savedProposal.selectedCandidateIds, Array.from(optimal.selected, candidate => candidate.id));
  loaded.elements.get("optimize-start").click();
  const cancelled = loaded.workers[1];
  cancelled.onmessage({ data: { type: "progress", update: { ...optimal, phase: "Searching" } } });
  loaded.elements.get("optimize-cancel").click();
  assert.equal(cancelled.terminated, true);
  assert.match(loaded.elements.get("optimizer-status").textContent, /feasible but not proven optimal.*Cancelled/);
  loaded.elements.get("optimize-start").click();
  loaded.workers[2].onerror({ message: "worker unavailable" });
  assert.match(loaded.elements.get("optimizer-error").textContent, /worker unavailable/);
  loaded.form.elements.targetSide.value = "blue";
  loaded.form.requestSubmit();
  assert.match(loaded.elements.get("calculation-error").textContent, /different/);
  assert.equal(loaded.elements.get("optimize-start").disabled, true);
  assert.equal(loaded.elements.get("optimizer-rows").children.length, 0);
  loaded.form.elements.targetSide.value = "red";
  loaded.form.requestSubmit();
  assert.equal(loaded.elements.get("calculation-error").textContent, "");
  assert.equal(loaded.elements.get("optimize-start").disabled, false);
  const missing = runPage(["app.js"]);
  assert.match(missing.elements.get("validation-status").textContent, /invalid/i);
  assert.equal(missing.elements.get("errors").children.length, 3);
  assert.equal(missing.form.hidden, true);
});
