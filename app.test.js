"use strict";

// Run with: node --test app.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { validateAndNormalize, distanceMeters } = require("./app.js");

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

test("offline page loads fixed scripts in order and displays supplied data and missing inputs", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const scripts = [...html.matchAll(/<script defer src="\.\/([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ["platform_details.js", "weapon_details.js", "weapon_lethality_details.js", "app.js"]);
  assert.doesNotMatch(html, /(?:https?:)?\/\//);

  function runPage(sourceFiles) {
    const elements = new Map();
    const document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { children: [], append(...children) { this.children.push(...children); } });
        return elements.get(id);
      },
      createElement() { return {}; }
    };
    const context = vm.createContext({ document });
    context.window = context;
    for (const file of sourceFiles) vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    return elements;
  }
  const loaded = runPage(scripts);
  assert.equal(loaded.get("validation-status").textContent, "Data validated successfully.");
  assert.ok(loaded.get("warnings").children.some(item => item.textContent.includes("no lethality")));
  const missing = runPage(["app.js"]);
  assert.match(missing.get("validation-status").textContent, /invalid/i);
  assert.equal(missing.get("errors").children.length, 3);
});
