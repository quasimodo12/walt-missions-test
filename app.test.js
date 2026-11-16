"use strict";

// Run with: node --test app.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { validateAndNormalize, distanceMeters, defaultFilters, summarizeEngagements, generateCandidates,
  diagnosePair, filterAndSortCandidates, candidatesCsv, exportPackage } = require("./app.js");

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

test("offline page loads fixed scripts, inspects, exports and handles missing inputs", async () => {
  const html = fs.readFileSync("index.html", "utf8");
  const scripts = [...html.matchAll(/<script defer src="\.\/([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ["platform_details.js", "weapon_details.js", "weapon_lethality_details.js", "app.js"]);
  assert.doesNotMatch(html, /(?:https?:)?\/\//);

  function runPage(sourceFiles) {
    const elements = new Map();
    const downloads = [];
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
    formControls.maxDistanceMeters = { value: "", valueAsNumber: NaN };
    formControls.minimumReserveByWeapon = { valueAsNumber: 0 };
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
        if (!elements.has(id)) {
          const item = element();
          if (id === "candidate-kind") item.value = "standard";
          if (id === "candidate-sort") item.value = "shooter";
          if (id === "candidate-search") item.value = "";
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
    const context = vm.createContext({
      document, Blob,
      URL: { createObjectURL(blob) { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL() {} },
      setTimeout(callback) { callback(); }
    });
    context.window = context;
    for (const file of sourceFiles) vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    return { elements, form, downloads };
  }
  const loaded = runPage(scripts);
  assert.equal(loaded.elements.get("validation-status").textContent, "Data validated successfully.");
  assert.ok(loaded.elements.get("warnings").children.some(item => item.textContent.includes("no lethality")));
  assert.ok(loaded.elements.get("summary-counts").children.some(item => item.textContent === "2287"));
  assert.equal(loaded.elements.get("candidate-rows").children.length, 0);
  loaded.elements.get("load-candidates").click();
  assert.equal(loaded.elements.get("candidate-rows").children.length, 25);
  assert.match(loaded.elements.get("candidate-count").textContent, /260 matching/);
  loaded.elements.get("next-page").click();
  assert.equal(loaded.elements.get("candidate-page").textContent, "Page 2 of 11");
  loaded.elements.get("candidate-rows").children[0].children[6].children[0].click();
  assert.match(loaded.elements.get("candidate-explanation").textContent, /Qualifies because/);
  loaded.elements.get("candidate-kind").value = "hybrid";
  loaded.elements.get("candidate-kind").events.change();
  assert.equal(loaded.elements.get("candidate-rows").children.length, 0);
  loaded.elements.get("load-candidates").click();
  assert.match(loaded.elements.get("candidate-count").textContent, /2287 matching/);
  assert.equal(loaded.elements.get("candidate-rows").children.length, 25);
  loaded.elements.get("export-csv").click();
  loaded.elements.get("export-json").click();
  assert.deepEqual(loaded.downloads.map(download => download.name), ["hybrid-candidates.csv", "filtered-engagements.json"]);
  const csv = await loaded.downloads[0].blob.text();
  assert.equal(csv.split("\r\n").length, 2288);
  const exported = JSON.parse(await loaded.downloads[1].blob.text());
  assert.equal(exported.candidates.standard.length, 260);
  assert.equal(exported.candidates.hybrid.length, 2287);
  assert.equal(exported.summary.standardCandidates, 260);
  loaded.elements.get("candidate-search").value = "not-a-platform-or-weapon";
  loaded.elements.get("candidate-search").events.input();
  assert.match(loaded.elements.get("candidate-count").textContent, /0 matching/);
  loaded.elements.get("export-json").click();
  const searched = JSON.parse(await loaded.downloads[2].blob.text());
  assert.deepEqual(searched.candidates, { standard: [], hybrid: [] });
  assert.equal(searched.summary.standardCandidates, 260);
  loaded.elements.get("diagnostic-shooter").value = "blue_ship_1";
  loaded.elements.get("diagnostic-target").value = "red_ship_1";
  loaded.elements.get("diagnostic-weapon").value = "BLUE_WEAPON_5";
  loaded.elements.get("diagnose").click();
  assert.match(loaded.elements.get("diagnostic-result").textContent, /No lethality record/);
  loaded.form.elements.shooterPlatformNames.children.find(option => option.value === "blue_ship_1").selected = true;
  loaded.form.requestSubmit();
  assert.equal(loaded.elements.get("summary-counts").children[1].textContent, "1");
  loaded.form.elements.targetSide.value = "blue";
  loaded.form.requestSubmit();
  assert.match(loaded.elements.get("calculation-error").textContent, /different/);
  assert.equal(loaded.elements.get("results").hidden, true);
  const missing = runPage(["app.js"]);
  assert.match(missing.elements.get("validation-status").textContent, /invalid/i);
  assert.equal(missing.elements.get("errors").children.length, 3);
  assert.equal(missing.form.hidden, true);
});
