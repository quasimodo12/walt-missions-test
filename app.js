"use strict";

const SCENARIO_RULES = Object.freeze({
  rangeUnit: "meters",
  rangeModel: "great-circle",
  defaultShooterSide: "blue",
  defaultTargetSide: "red",
  requireOpposingSides: true,
  exactLethalityVolley: true,
  hybridShooterLimit: 2,
  hybridSameWeaponOnly: true
});

// The data layer has no dependency on the DOM or the source of the arrays.
const MissionData = (() => {
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function text(value, label, errors) {
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${label} must be a non-empty string.`);
    }
    return value;
  }

  function number(value, label, errors, options = {}) {
    const validInput = typeof value === "number" ||
      (typeof value === "string" && value.trim() !== "");
    const result = validInput ? Number(value) : NaN;
    if (!Number.isFinite(result) ||
        (options.integer && !Number.isSafeInteger(result)) ||
        (options.min !== undefined && result < options.min) ||
        (options.max !== undefined && result > options.max)) {
      const bounds = [
        options.integer ? "a safe integer" : "a finite number",
        options.min !== undefined ? `at least ${options.min}` : null,
        options.max !== undefined ? `at most ${options.max}` : null
      ].filter(Boolean).join(", ");
      errors.push(`${label} must be ${bounds}.`);
    }
    return result;
  }

  function stringArray(value, label, errors) {
    if (!Array.isArray(value)) {
      errors.push(`${label} must be an array.`);
      return [];
    }
    return Array.from(value, (item, index) => text(item, `${label}[${index}]`, errors));
  }

  function unique(value, seen, label, errors) {
    if (typeof value !== "string" || value.trim() === "") return;
    if (seen.has(value)) errors.push(`${label} "${value}" is duplicated.`);
    seen.add(value);
  }

  function validateAndNormalize(input) {
    const errors = [];
    const warnings = [];
    const arrays = {};
    for (const key of ["platforms", "weapons", "lethality"]) {
      if (!Array.isArray(input?.[key])) {
        errors.push(`${key} must be a loaded array.`);
        arrays[key] = [];
      } else {
        arrays[key] = input[key];
      }
    }

    const platformNames = new Set();
    const weaponNames = new Set();
    const lethalityKeys = new Map();
    const platforms = Array.from(arrays.platforms, (record, index) => {
      const label = `platforms[${index}]`;
      if (!isRecord(record)) {
        errors.push(`${label} must be an object.`);
        return null;
      }
      const name = text(record.platform_name, `${label}.platform_name`, errors);
      unique(name, platformNames, "Platform name", errors);
      const carriedNames = new Set();
      let carried = [];
      if (!Array.isArray(record.weapons)) {
        errors.push(`${label}.weapons must be an array.`);
      } else {
        carried = Array.from(record.weapons, (item, i) => {
          const itemLabel = `${label}.weapons[${i}]`;
          if (!isRecord(item)) {
            errors.push(`${itemLabel} must be an object.`);
            return null;
          }
          const weapon = text(item.name, `${itemLabel}.name`, errors);
          unique(weapon, carriedNames, `${label} weapon`, errors);
          return {
            ...item,
            name: weapon,
            quantity: number(item.quantity, `${itemLabel}.quantity`, errors, { integer: true, min: 0 })
          };
        });
      }
      return {
        ...record,
        platform_name: name,
        side: text(record.side, `${label}.side`, errors),
        group: text(record.group, `${label}.group`, errors),
        subgroups: stringArray(record.subgroups, `${label}.subgroups`, errors),
        latitude: number(record.latitude, `${label}.latitude`, errors, { min: -90, max: 90 }),
        longitude: number(record.longitude, `${label}.longitude`, errors, { min: -180, max: 180 }),
        altitude: number(record.altitude, `${label}.altitude`, errors),
        category: text(record.category, `${label}.category`, errors),
        weapons: carried,
        sensors: stringArray(record.sensors, `${label}.sensors`, errors),
        type: text(record.type, `${label}.type`, errors)
      };
    });

    const weapons = Array.from(arrays.weapons, (record, index) => {
      const label = `weapons[${index}]`;
      if (!isRecord(record)) {
        errors.push(`${label} must be an object.`);
        return null;
      }
      const name = text(record.weapon_name, `${label}.weapon_name`, errors);
      unique(name, weaponNames, "Weapon name", errors);
      const min = number(record.weapon_min_range, `${label}.weapon_min_range`, errors, { min: 0 });
      const max = number(record.weapon_max_range, `${label}.weapon_max_range`, errors, { min: 0 });
      if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
        errors.push(`${label} minimum range exceeds maximum range.`);
      }
      return {
        ...record,
        weapon_name: name,
        side: text(record.side, `${label}.side`, errors),
        weapon_min_range: min,
        weapon_max_range: max
      };
    });

    const lethality = Array.from(arrays.lethality, (record, index) => {
      const label = `lethality[${index}]`;
      if (!isRecord(record)) {
        errors.push(`${label} must be an object.`);
        return null;
      }
      const weapon = text(record.weapon, `${label}.weapon`, errors);
      const target = text(record.platformType, `${label}.platformType`, errors);
      if (typeof weapon === "string" && weapon.trim() && typeof target === "string" && target.trim()) {
        if (!lethalityKeys.has(weapon)) lethalityKeys.set(weapon, new Set());
        if (lethalityKeys.get(weapon).has(target)) {
          errors.push(`Lethality key "${weapon}" + "${target}" is duplicated.`);
        }
        lethalityKeys.get(weapon).add(target);
      }
      return {
        ...record,
        weapon,
        platformType: target,
        quantity: number(record.quantity, `${label}.quantity`, errors, { integer: true, min: 1 })
      };
    });

    // Cross-reference checks run only on structurally valid data.
    if (errors.length) return { data: null, indexes: null, errors, warnings };

    const data = { platforms, weapons, lethality };
    const indexes = buildIndexes(data);
    const warnedCarried = new Set();
    const warnedTypes = new Set();
    const targetTypes = new Set(lethality.map(record => record.platformType));
    for (const platform of platforms) {
      for (const item of platform.weapons) {
        if (warnedCarried.has(item.name)) continue;
        warnedCarried.add(item.name);
        if (!indexes.weaponByName.has(item.name)) {
          warnings.push(`Carried weapon "${item.name}" has no weapon definition.`);
        }
        if (!indexes.lethalityByWeaponAndTargetType.has(item.name)) {
          warnings.push(`Carried weapon "${item.name}" has no lethality record.`);
        }
      }
      if (!targetTypes.has(platform.type) && !warnedTypes.has(platform.type)) {
        warnings.push(`Platform type "${platform.type}" has no applicable lethality records.`);
        warnedTypes.add(platform.type);
      }
    }
    for (const weapon of indexes.lethalityByWeaponAndTargetType.keys()) {
      if (!indexes.weaponByName.has(weapon)) {
        warnings.push(`Lethality records reference undefined weapon "${weapon}".`);
      }
    }
    return { data, indexes, errors, warnings };
  }

  function buildIndexes(data) {
    const platformByName = new Map();
    const weaponByName = new Map();
    const lethalityByWeaponAndTargetType = new Map();
    const inventoryByPlatformAndWeapon = new Map();
    const platformsBySide = new Map();
    for (const platform of data.platforms) {
      platformByName.set(platform.platform_name, platform);
      inventoryByPlatformAndWeapon.set(
        platform.platform_name,
        new Map(platform.weapons.map(item => [item.name, item.quantity]))
      );
      if (!platformsBySide.has(platform.side)) platformsBySide.set(platform.side, []);
      platformsBySide.get(platform.side).push(platform);
    }
    for (const weapon of data.weapons) weaponByName.set(weapon.weapon_name, weapon);
    for (const record of data.lethality) {
      if (!lethalityByWeaponAndTargetType.has(record.weapon)) {
        lethalityByWeaponAndTargetType.set(record.weapon, new Map());
      }
      lethalityByWeaponAndTargetType.get(record.weapon).set(record.platformType, record);
    }
    return { platformByName, weaponByName, lethalityByWeaponAndTargetType, inventoryByPlatformAndWeapon, platformsBySide };
  }

  function distanceMeters(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const latitudeDelta = radians(b.latitude - a.latitude);
    const longitudeDelta = radians(b.longitude - a.longitude);
    const h = Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }

  function defaultFilters() {
    return {
      shooterSide: SCENARIO_RULES.defaultShooterSide,
      targetSide: SCENARIO_RULES.defaultTargetSide,
      shooterPlatformNames: [], targetPlatformNames: [],
      shooterGroups: [], targetGroups: [],
      shooterSubgroups: [], targetSubgroups: [],
      shooterTypes: [], targetTypes: [],
      weaponNames: [], categories: [],
      maxDistanceMeters: null,
      includeStandardEngagements: true,
      includeHybridEngagements: true,
      minimumReserveByWeapon: 0
    };
  }

  function summarizeEngagements(data, indexes, filters) {
    if (SCENARIO_RULES.requireOpposingSides && filters.shooterSide === filters.targetSide) {
      throw new Error("Shooter and target sides must be different.");
    }
    if (!Number.isSafeInteger(filters.minimumReserveByWeapon) || filters.minimumReserveByWeapon < 0) {
      throw new Error("Minimum reserve must be a non-negative safe integer.");
    }
    if (filters.maxDistanceMeters !== null &&
        (!Number.isFinite(filters.maxDistanceMeters) || filters.maxDistanceMeters < 0)) {
      throw new Error("Maximum distance must be a non-negative number of meters.");
    }

    function matches(platform, prefix) {
      const selected = (list, value) => !list.length || list.includes(value);
      return selected(filters[`${prefix}PlatformNames`], platform.platform_name) &&
        selected(filters[`${prefix}Groups`], platform.group) &&
        (!filters[`${prefix}Subgroups`].length ||
          platform.subgroups.some(group => filters[`${prefix}Subgroups`].includes(group))) &&
        selected(filters[`${prefix}Types`], platform.type) &&
        selected(filters.categories, platform.category);
    }

    const shooters = (indexes.platformsBySide.get(filters.shooterSide) || []).filter(p => matches(p, "shooter"));
    const targets = (indexes.platformsBySide.get(filters.targetSide) || []).filter(p => matches(p, "target"));
    const summary = {
      shooterCount: shooters.length, targetCount: targets.length,
      pairCount: 0, distanceQualifiedPairs: 0, lethalityMatches: 0, rangeQualified: 0,
      standardCandidates: 0, hybridPatterns: 0, eligibleTargets: 0,
      byWeapon: new Map(), byTargetType: new Map(),
      byShooterGroup: new Map(), byTargetGroup: new Map()
    };
    const distances = new Map();
    const eligible = new Set();
    const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    for (const target of targets) {
      const hybridByWeapon = new Map();
      for (const shooter of shooters) {
        if (shooter.platform_name === target.platform_name) continue;
        summary.pairCount++;
        if (!distances.has(shooter.platform_name)) distances.set(shooter.platform_name, new Map());
        const shooterDistances = distances.get(shooter.platform_name);
        const key = `${shooter.platform_name}::${target.platform_name}`;
        if (!shooterDistances.has(key)) shooterDistances.set(key, distanceMeters(shooter, target));
        const distance = shooterDistances.get(key);
        if (filters.maxDistanceMeters !== null && distance > filters.maxDistanceMeters) continue;
        summary.distanceQualifiedPairs++;
        for (const item of shooter.weapons) {
          if (filters.weaponNames.length && !filters.weaponNames.includes(item.name)) continue;
          const weapon = indexes.weaponByName.get(item.name);
          const lethality = indexes.lethalityByWeaponAndTargetType.get(item.name)?.get(target.type);
          if (!weapon || !lethality) continue;
          summary.lethalityMatches++;
          if (distance < weapon.weapon_min_range || distance > weapon.weapon_max_range) continue;
          summary.rangeQualified++;
          const available = Math.max(0, item.quantity - filters.minimumReserveByWeapon);
          if (filters.includeStandardEngagements && available >= lethality.quantity) {
            summary.standardCandidates++;
            eligible.add(target.platform_name);
            increment(summary.byWeapon, item.name);
            increment(summary.byTargetType, target.type);
            increment(summary.byShooterGroup, shooter.group);
            increment(summary.byTargetGroup, target.group);
          }
          if (filters.includeHybridEngagements && available > 0) {
            if (!hybridByWeapon.has(item.name)) hybridByWeapon.set(item.name, []);
            hybridByWeapon.get(item.name).push({ available, required: lethality.quantity });
          }
        }
      }
      if (filters.includeHybridEngagements) {
        for (const contributors of hybridByWeapon.values()) {
          for (let a = 0; a < contributors.length; a++) {
            for (let b = a + 1; b < contributors.length; b++) {
              const required = contributors[a].required;
              const lower = Math.max(1, required - contributors[b].available);
              const upper = Math.min(contributors[a].available, required - 1);
              summary.hybridPatterns += Math.max(0, upper - lower + 1);
              if (!Number.isSafeInteger(summary.hybridPatterns)) {
                throw new Error("Hybrid allocation count exceeds the safe integer limit.");
              }
            }
          }
        }
      }
    }
    summary.eligibleTargets = eligible.size;
    return summary;
  }

  return { validateAndNormalize, distanceMeters, defaultFilters, summarizeEngagements };
})();

function renderStatus(input, result) {
  const status = document.getElementById("validation-status");
  status.textContent = result.errors.length
    ? "Data invalid. Calculations must remain disabled."
    : "Data validated successfully.";
  status.className = result.errors.length ? "invalid" : "valid";

  const counts = document.getElementById("data-counts");
  const addCount = (label, value) => {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = String(value);
    counts.append(term, description);
  };
  if (Array.isArray(input.platforms)) {
    const sides = new Map();
    for (const platform of input.platforms) {
      const side = isDisplayableSide(platform) ? platform.side : "(invalid or missing side)";
      sides.set(side, (sides.get(side) || 0) + 1);
    }
    if (!sides.size) addCount("Platforms", 0);
    for (const [side, count] of sides) addCount(`Platforms: ${side}`, count);
  } else {
    addCount("Platforms", "Unavailable");
  }
  addCount("Weapon definitions", Array.isArray(input.weapons) ? input.weapons.length : "Unavailable");
  addCount("Lethality records", Array.isArray(input.lethality) ? input.lethality.length : "Unavailable");

  function renderList(id, entries) {
    const list = document.getElementById(id);
    for (const entry of entries.length ? entries : ["None."]) {
      const item = document.createElement("li");
      item.textContent = entry;
      list.append(item);
    }
  }
  renderList("errors", result.errors);
  renderList("warnings", result.warnings);
  renderList("assumptions", [
    `Ranges are in ${SCENARIO_RULES.rangeUnit}; distance uses the ${SCENARIO_RULES.rangeModel} model without altitude.`,
    `Default shooter side: ${SCENARIO_RULES.defaultShooterSide}; default target side: ${SCENARIO_RULES.defaultTargetSide}.`,
    `Opposing sides required: ${SCENARIO_RULES.requireOpposingSides}; exact lethality volley: ${SCENARIO_RULES.exactLethalityVolley}.`,
    `Hybrid shooter limit: ${SCENARIO_RULES.hybridShooterLimit}; same weapon only: ${SCENARIO_RULES.hybridSameWeaponOnly}.`,
    "Sensors, movement, timing, doctrine, and command-and-control constraints are not used."
  ]);
}

function isDisplayableSide(platform) {
  return platform && typeof platform === "object" &&
    typeof platform.side === "string" && platform.side.trim() !== "";
}

function initializeEngagements(result) {
  const form = document.getElementById("filters");
  if (result.errors.length) {
    form.hidden = true;
    document.getElementById("results").hidden = true;
    document.getElementById("calculation-error").textContent = "Calculations are unavailable until input errors are fixed.";
    return;
  }
  const { data, indexes } = result;
  const defaults = MissionData.defaultFilters();
  const controls = {
    shooterSide: "side", targetSide: "side",
    shooterPlatformNames: "platform_name", targetPlatformNames: "platform_name",
    shooterGroups: "group", targetGroups: "group",
    shooterSubgroups: "subgroups", targetSubgroups: "subgroups",
    shooterTypes: "type", targetTypes: "type",
    categories: "category"
  };
  for (const [name, property] of Object.entries(controls)) {
    const values = new Set(data.platforms.flatMap(platform =>
      Array.isArray(platform[property]) ? platform[property] : [platform[property]]
    ));
    if (property === "side") values.add(defaults[name]);
    populateSelect(form.elements[name], values, defaults[name]);
  }
  populateSelect(form.elements.weaponNames, new Set(data.platforms.flatMap(p => p.weapons.map(w => w.name))));

  form.addEventListener("submit", event => {
    event.preventDefault();
    const filters = MissionData.defaultFilters();
    for (const name of Object.keys(controls).concat("weaponNames")) {
      const control = form.elements[name];
      filters[name] = control.multiple
        ? Array.from(control.selectedOptions, option => option.value)
        : control.value;
    }
    filters.maxDistanceMeters = form.elements.maxDistanceMeters.value === ""
      ? null : form.elements.maxDistanceMeters.valueAsNumber;
    filters.minimumReserveByWeapon = form.elements.minimumReserveByWeapon.valueAsNumber;
    filters.includeStandardEngagements = form.elements.includeStandardEngagements.checked;
    filters.includeHybridEngagements = form.elements.includeHybridEngagements.checked;
    const error = document.getElementById("calculation-error");
    let summary;
    try {
      summary = MissionData.summarizeEngagements(data, indexes, filters);
      error.textContent = "";
    } catch (problem) {
      error.textContent = problem.message;
      document.getElementById("results").hidden = true;
      return;
    }
    renderSummary(summary, filters);
  });
  form.requestSubmit();
}

function populateSelect(select, values, selected) {
  for (const value of [...values].sort()) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    select.append(option);
  }
}

function renderSummary(summary, filters) {
  const results = document.getElementById("results");
  results.hidden = false;
  const counts = document.getElementById("summary-counts");
  counts.replaceChildren();
  const countRows = [
    ["Selected shooters", summary.shooterCount],
    ["Selected targets", summary.targetCount],
    ["Shooter-target pairs", summary.pairCount],
    ["Pairs within maximum distance filter", summary.distanceQualifiedPairs],
    ["Weapon-target lethality matches", summary.lethalityMatches],
    ["Configured geometric-range qualified combinations", summary.rangeQualified],
    ["Standard engagement candidates", filters.includeStandardEngagements ? summary.standardCandidates : "Not included"],
    ["Eligible targets (at least one standard candidate)", filters.includeStandardEngagements ? summary.eligibleTargets : "Not included"],
    ["Pairwise hybrid allocation patterns", filters.includeHybridEngagements ? summary.hybridPatterns : "Not included"]
  ];
  for (const [label, value] of countRows) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = String(value);
    counts.append(term, description);
  }
  for (const [id, map] of [
    ["by-weapon", summary.byWeapon], ["by-target-type", summary.byTargetType],
    ["by-shooter-group", summary.byShooterGroup], ["by-target-group", summary.byTargetGroup]
  ]) {
    const list = document.getElementById(id);
    list.replaceChildren();
    if (!filters.includeStandardEngagements || !map.size) {
      const item = document.createElement("li");
      item.textContent = filters.includeStandardEngagements ? "None." : "Standard candidates not included.";
      list.append(item);
    } else {
      for (const [name, count] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
        const item = document.createElement("li");
        item.textContent = `${name}: ${count}`;
        list.append(item);
      }
    }
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const input = {
    platforms: window.PLATFORM_DATA,
    weapons: window.WEAPON_DATA,
    lethality: window.WEAPON_LETHALITY_DATA
  };
  const result = MissionData.validateAndNormalize(input);
  renderStatus(input, result);
  initializeEngagements(result);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ...MissionData, SCENARIO_RULES };
}
