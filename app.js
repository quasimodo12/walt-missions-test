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
function createMissionData() {
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

  function matchesPlatform(platform, prefix, filters) {
    const selected = (list, value) => !list.length || list.includes(value);
    return platform.side === filters[`${prefix}Side`] &&
      selected(filters[`${prefix}PlatformNames`], platform.platform_name) &&
      selected(filters[`${prefix}Groups`], platform.group) &&
      (!filters[`${prefix}Subgroups`].length ||
        platform.subgroups.some(group => filters[`${prefix}Subgroups`].includes(group))) &&
      selected(filters[`${prefix}Types`], platform.type) &&
      selected(filters.categories, platform.category);
  }

  function candidateId(kind, ...parts) {
    return [kind, ...parts.map(part => encodeURIComponent(String(part)))].join("::");
  }

  function validateFilters(filters) {
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
  }

  function summarizeEngagements(data, indexes, filters, collect = null, checkpoint = null) {
    validateFilters(filters);
    const shooters = (indexes.platformsBySide.get(filters.shooterSide) || []).filter(p => matchesPlatform(p, "shooter", filters));
    const targets = (indexes.platformsBySide.get(filters.targetSide) || []).filter(p => matchesPlatform(p, "target", filters));
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
      checkpoint?.();
      const hybridByWeapon = new Map();
      for (const shooter of shooters) {
        checkpoint?.();
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
          checkpoint?.();
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
            if (collect?.standard) {
              collect.standard({
                id: candidateId("std", shooter.platform_name, target.platform_name, item.name),
                kind: "standard", shooterPlatform: shooter.platform_name,
                shooterSide: shooter.side, shooterGroup: shooter.group,
                targetPlatform: target.platform_name, targetSide: target.side,
                targetType: target.type, weapon: item.name, distanceMeters: distance,
                weaponMinRangeMeters: weapon.weapon_min_range, weaponMaxRangeMeters: weapon.weapon_max_range,
                shooterLoadedQuantity: item.quantity, shooterReserveQuantity: filters.minimumReserveByWeapon,
                shooterAvailableQuantity: available, requiredQuantity: lethality.quantity
              });
            }
          }
          if (filters.includeHybridEngagements && available > 0) {
            if (!hybridByWeapon.has(item.name)) hybridByWeapon.set(item.name, []);
            hybridByWeapon.get(item.name).push({ shooter, item, weapon, distance, available, required: lethality.quantity });
          }
        }
      }
      if (filters.includeHybridEngagements) {
        for (const contributors of hybridByWeapon.values()) {
          if (collect?.hybrid) contributors.sort((a, b) => a.shooter.platform_name < b.shooter.platform_name ? -1 : a.shooter.platform_name > b.shooter.platform_name ? 1 : 0);
          for (let a = 0; a < contributors.length; a++) {
            for (let b = a + 1; b < contributors.length; b++) {
              checkpoint?.();
              const required = contributors[a].required;
              const lower = Math.max(1, required - contributors[b].available);
              const upper = Math.min(contributors[a].available, required - 1);
              summary.hybridPatterns += Math.max(0, upper - lower + 1);
              if (!Number.isSafeInteger(summary.hybridPatterns)) {
                throw new Error("Hybrid allocation count exceeds the safe integer limit.");
              }
              if (collect?.hybrid) {
                const first = contributors[a], second = contributors[b];
                for (let allocation = lower; allocation <= upper; allocation++) {
                  checkpoint?.();
                  const other = required - allocation;
                  collect.hybrid({
                    id: candidateId("hyb", first.shooter.platform_name, second.shooter.platform_name, target.platform_name, first.item.name, allocation, other),
                    kind: "hybrid", shooterAPlatform: first.shooter.platform_name,
                    shooterBPlatform: second.shooter.platform_name,
                    shooterAGroup: first.shooter.group, shooterBGroup: second.shooter.group,
                    targetPlatform: target.platform_name,
                    targetType: target.type, weapon: first.item.name,
                    distanceShooterAToTargetMeters: first.distance, distanceShooterBToTargetMeters: second.distance,
                    weaponMinRangeMeters: first.weapon.weapon_min_range, weaponMaxRangeMeters: first.weapon.weapon_max_range,
                    shooterAAllocatedQuantity: allocation, shooterBAllocatedQuantity: other,
                    shooterALoadedQuantity: first.item.quantity, shooterBLoadedQuantity: second.item.quantity,
                    shooterAReserveQuantity: filters.minimumReserveByWeapon, shooterBReserveQuantity: filters.minimumReserveByWeapon,
                    shooterAAvailableQuantity: first.available, shooterBAvailableQuantity: second.available,
                    requiredQuantity: required
                  });
                }
              }
            }
          }
        }
      }
    }
    summary.eligibleTargets = eligible.size;
    return summary;
  }

  function generateCandidates(data, indexes, filters, kind) {
    if (kind !== "standard" && kind !== "hybrid") throw new Error("Unknown candidate kind.");
    const candidates = [];
    summarizeEngagements(data, indexes, filters, { [kind]: candidate => candidates.push(candidate) });
    return candidates;
  }

  function diagnosePair(indexes, filters, shooterName, targetName, weaponName) {
    const shooter = indexes.platformByName.get(shooterName);
    const target = indexes.platformByName.get(targetName);
    if (!shooter || !target) throw new Error("Select an existing shooter and target.");
    const failures = [];
    if (!matchesPlatform(shooter, "shooter", filters)) failures.push("Shooter excluded by the active filters.");
    if (!matchesPlatform(target, "target", filters)) failures.push("Target excluded by the active filters.");
    if (shooterName === targetName) failures.push("Shooter and target must be different platforms.");
    if (filters.weaponNames.length && !filters.weaponNames.includes(weaponName)) failures.push("Weapon excluded by the active filters.");
    const distance = distanceMeters(shooter, target);
    if (filters.maxDistanceMeters !== null && distance > filters.maxDistanceMeters) failures.push("Pair exceeds the maximum distance filter.");
    const inventory = shooter.weapons.find(item => item.name === weaponName);
    if (!inventory) failures.push("Shooter does not carry this weapon.");
    const weapon = indexes.weaponByName.get(weaponName);
    if (!weapon) failures.push("Weapon is missing from weapon definitions.");
    const lethality = indexes.lethalityByWeaponAndTargetType.get(weaponName)?.get(target.type);
    if (!lethality) failures.push("No lethality record for this weapon and target type.");
    if (weapon && distance < weapon.weapon_min_range) failures.push("Target is below minimum weapon range.");
    if (weapon && distance > weapon.weapon_max_range) failures.push("Target is beyond maximum weapon range.");
    if (inventory && lethality) {
      if (inventory.quantity < lethality.quantity) failures.push("Insufficient loaded weapon quantity.");
      else if (Math.max(0, inventory.quantity - filters.minimumReserveByWeapon) < lethality.quantity) failures.push("Reserve rule prevents qualification.");
    }
    return { distanceMeters: distance, failures };
  }

  function filterAndSortCandidates(candidates, search, sort) {
    const needle = search.trim().toLocaleLowerCase();
    const fields = {
      shooter: c => c.shooterPlatform || `${c.shooterAPlatform} ${c.shooterBPlatform}`,
      target: c => c.targetPlatform, weapon: c => c.weapon,
      distance: c => c.kind === "standard" ? c.distanceMeters : Math.max(c.distanceShooterAToTargetMeters, c.distanceShooterBToTargetMeters),
      required: c => c.requiredQuantity,
      group: c => c.kind === "standard" ? c.shooterGroup : `${c.shooterAGroup} ${c.shooterBGroup}`,
      type: c => c.targetType
    };
    if (!fields[sort]) throw new Error("Unknown sort field.");
    return candidates.filter(c => !needle || [c.shooterPlatform, c.shooterAPlatform, c.shooterBPlatform, c.targetPlatform, c.weapon]
      .some(value => value && value.toLocaleLowerCase().includes(needle)))
      .slice().sort((a, b) => {
        const x = fields[sort](a), y = fields[sort](b);
        const comparison = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
        return comparison || a.id.localeCompare(b.id);
      });
  }

  function candidatesCsv(candidates, kind) {
    const fields = candidates.length ? Object.keys(candidates[0]) :
      kind === "standard" ? [
        "id", "kind", "shooterPlatform", "shooterSide", "shooterGroup", "targetPlatform", "targetSide",
        "targetType", "weapon", "distanceMeters", "weaponMinRangeMeters", "weaponMaxRangeMeters",
        "shooterLoadedQuantity", "shooterReserveQuantity", "shooterAvailableQuantity", "requiredQuantity"
      ] : [
        "id", "kind", "shooterAPlatform", "shooterBPlatform", "shooterAGroup", "shooterBGroup",
        "targetPlatform", "targetType", "weapon", "distanceShooterAToTargetMeters", "distanceShooterBToTargetMeters",
        "weaponMinRangeMeters", "weaponMaxRangeMeters", "shooterAAllocatedQuantity", "shooterBAllocatedQuantity",
        "shooterALoadedQuantity", "shooterBLoadedQuantity", "shooterAReserveQuantity", "shooterBReserveQuantity",
        "shooterAAvailableQuantity", "shooterBAvailableQuantity", "requiredQuantity"
      ];
    const quote = value => {
      let text = String(value ?? "");
      if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    return [fields.map(quote).join(","), ...candidates.map(c => fields.map(key => quote(c[key])).join(","))].join("\r\n");
  }

  function exportPackage(filters, summary, candidates, view, timestamp = new Date().toISOString()) {
    return {
      filters, scenarioRules: SCENARIO_RULES,
      summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value instanceof Map ? Object.fromEntries(value) : value])),
      generatedAt: timestamp, view, candidates
    };
  }

  function candidateAllocations(candidate) {
    return candidate.kind === "standard"
      ? [[candidate.shooterPlatform, candidate.requiredQuantity]]
      : [[candidate.shooterAPlatform, candidate.shooterAAllocatedQuantity],
        [candidate.shooterBPlatform, candidate.shooterBAllocatedQuantity]];
  }

  function validateMissionPackage(packageData) {
    if (!isRecord(packageData) || packageData.formatVersion !== 1 ||
        !isRecord(packageData.scenarioRules) || !isRecord(packageData.filters) ||
        !Array.isArray(packageData.selectedCandidateIds) || !Array.isArray(packageData.selectedCandidateSnapshots) ||
        (packageData.scenarioDataFingerprint != null && typeof packageData.scenarioDataFingerprint !== "string") ||
        (packageData.permitDuplicateTargets !== undefined && typeof packageData.permitDuplicateTargets !== "boolean")) {
      throw new Error("Invalid or unsupported mission package.");
    }
    const defaults = defaultFilters();
    for (const [key, value] of Object.entries(defaults)) {
      const actual = packageData.filters[key];
      const valid = Array.isArray(value) ? Array.isArray(actual) && actual.every(item => typeof item === "string" && item.trim()) :
        value === null ? actual === null || (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) :
        typeof value === "boolean" ? typeof actual === "boolean" :
        typeof value === "number" ? Number.isSafeInteger(actual) && actual >= 0 :
        typeof actual === "string" && actual.trim();
      if (!valid) throw new Error(`Invalid mission filter: ${key}.`);
    }
    if (SCENARIO_RULES.requireOpposingSides && packageData.filters.shooterSide === packageData.filters.targetSide) {
      throw new Error("Mission shooter and target sides must be different.");
    }
    if (packageData.selectedCandidateIds.length !== packageData.selectedCandidateSnapshots.length ||
        new Set(packageData.selectedCandidateIds).size !== packageData.selectedCandidateIds.length) {
      throw new Error("Mission candidate IDs and snapshots must match without duplicates.");
    }
    for (const [index, candidate] of packageData.selectedCandidateSnapshots.entries()) {
      if (!isRecord(candidate) || !["standard", "hybrid"].includes(candidate.kind) ||
          ![candidate.targetPlatform, candidate.weapon].every(value => typeof value === "string" && value.trim()) ||
          !Number.isSafeInteger(candidate.requiredQuantity) || candidate.requiredQuantity < 1) {
        throw new Error(`Invalid mission candidate snapshot ${index + 1}.`);
      }
      const allocations = candidateAllocations(candidate);
      if (!allocations.every(([name, quantity]) => typeof name === "string" && name.trim() &&
          Number.isSafeInteger(quantity) && quantity > 0) ||
          allocations.some(([name]) => name === candidate.targetPlatform) ||
          (candidate.kind === "hybrid" && (allocations[0][0] >= allocations[1][0] ||
            allocations[0][1] + allocations[1][1] !== candidate.requiredQuantity))) {
        throw new Error(`Invalid mission candidate allocation ${index + 1}.`);
      }
      const id = candidate.kind === "standard"
        ? candidateId("std", allocations[0][0], candidate.targetPlatform, candidate.weapon)
        : candidateId("hyb", allocations[0][0], allocations[1][0], candidate.targetPlatform, candidate.weapon,
          allocations[0][1], allocations[1][1]);
      if (candidate.id !== id || packageData.selectedCandidateIds[index] !== id) {
        throw new Error(`Mission candidate ID does not match snapshot ${index + 1}.`);
      }
    }
    return { ...packageData, scenarioDataFingerprint: packageData.scenarioDataFingerprint ?? null,
      permitDuplicateTargets: packageData.permitDuplicateTargets ?? false };
  }

  function scenarioFingerprint(data) {
    return JSON.stringify(data);
  }

  function createMissionPackage(data, filters, selected, permitDuplicateTargets) {
    return {
      formatVersion: 1, scenarioRules: { ...SCENARIO_RULES }, filters,
      selectedCandidateIds: selected.map(candidate => candidate.id),
      selectedCandidateSnapshots: selected,
      permitDuplicateTargets, scenarioDataFingerprint: scenarioFingerprint(data)
    };
  }

  function evaluateMission(data, indexes, packageData) {
    validateMissionPackage(packageData);
    const { filters, selectedCandidateSnapshots: selected } = packageData;
    const scenarioChanged = packageData.scenarioDataFingerprint !== scenarioFingerprint(data) ||
      JSON.stringify(packageData.scenarioRules) !== JSON.stringify(SCENARIO_RULES);
    const inventory = new Map(), expenditures = new Map(), targets = new Map();
    const addSafe = (a, b) => {
      const sum = a + b;
      if (!Number.isSafeInteger(sum)) throw new Error("Mission expenditure exceeds the safe integer limit.");
      return sum;
    };
    for (const platform of data.platforms.filter(p => p.side === filters.shooterSide)) {
      for (const item of platform.weapons) {
        if (!inventory.has(platform.platform_name)) inventory.set(platform.platform_name, new Map());
        inventory.get(platform.platform_name).set(item.name, { platform: platform.platform_name, weapon: item.name, loaded: item.quantity, planned: 0 });
      }
    }
    const results = selected.map(candidate => {
      const failures = [];
      const differences = [];
      const compare = (field, current) => {
        if (current !== undefined && candidate[field] !== undefined && candidate[field] !== current) {
          differences.push(`${field}: saved ${candidate[field]}; current ${current}.`);
        }
      };
      const target = indexes.platformByName.get(candidate.targetPlatform);
      const weapon = indexes.weaponByName.get(candidate.weapon);
      const lethality = target && indexes.lethalityByWeaponAndTargetType.get(candidate.weapon)?.get(target.type);
      compare("targetType", target?.type);
      compare("targetSide", target?.side);
      compare("weaponMinRangeMeters", weapon?.weapon_min_range);
      compare("weaponMaxRangeMeters", weapon?.weapon_max_range);
      compare("requiredQuantity", lethality?.quantity);
      if (!target || !matchesPlatform(target, "target", filters)) failures.push("Target is missing or excluded by the current filters.");
      if (!weapon || (filters.weaponNames.length && !filters.weaponNames.includes(candidate.weapon))) failures.push("Weapon is missing or excluded by the current filters.");
      if (!lethality || lethality.quantity !== candidate.requiredQuantity) failures.push("Lethality requirement is missing or changed; the saved allocation was not replaced.");
      if (!filters[candidate.kind === "standard" ? "includeStandardEngagements" : "includeHybridEngagements"]) failures.push("Candidate type is excluded by the current filters.");
      for (const [position, [name, quantity]] of candidateAllocations(candidate).entries()) {
        const shooter = indexes.platformByName.get(name);
        const loaded = indexes.inventoryByPlatformAndWeapon.get(name)?.get(candidate.weapon);
        const prefix = candidate.kind === "standard" ? "shooter" : position === 0 ? "shooterA" : "shooterB";
        compare(`${prefix}Group`, shooter?.group);
        if (candidate.kind === "standard") compare("shooterSide", shooter?.side);
        compare(`${prefix}LoadedQuantity`, loaded);
        compare(`${prefix}ReserveQuantity`, filters.minimumReserveByWeapon);
        if (loaded !== undefined) compare(`${prefix}AvailableQuantity`, Math.max(0, loaded - filters.minimumReserveByWeapon));
        if (!shooter || !matchesPlatform(shooter, "shooter", filters)) failures.push(`${name}: shooter is missing or excluded by the current filters.`);
        if (loaded === undefined || Math.max(0, loaded - filters.minimumReserveByWeapon) < quantity) failures.push(`${name}: saved allocation exceeds available inventory.`);
        if (shooter && target && weapon) {
          const distance = distanceMeters(shooter, target);
          compare(candidate.kind === "standard" ? "distanceMeters" : `distanceShooter${position === 0 ? "A" : "B"}ToTargetMeters`, distance);
          if (distance < weapon.weapon_min_range || distance > weapon.weapon_max_range ||
              (filters.maxDistanceMeters !== null && distance > filters.maxDistanceMeters)) failures.push(`${name}: target is outside the permitted range.`);
        }
        if (!inventory.has(name)) inventory.set(name, new Map());
        const weapons = inventory.get(name);
        if (!weapons.has(candidate.weapon)) weapons.set(candidate.weapon, { platform: name, weapon: candidate.weapon, loaded: loaded ?? 0, planned: 0 });
        const entry = weapons.get(candidate.weapon);
        entry.planned = addSafe(entry.planned, quantity);
        expenditures.set(candidate.weapon, addSafe(expenditures.get(candidate.weapon) || 0, quantity));
      }
      targets.set(candidate.targetPlatform, (targets.get(candidate.targetPlatform) || 0) + 1);
      return { candidate, failures, differences, status: failures.length ? "conflict" : scenarioChanged || differences.length ? "warning" : "feasible" };
    });
    const inventoryRows = [...inventory.values()].flatMap(weapons => [...weapons.values()]).map(entry => {
      const available = Math.max(0, entry.loaded - filters.minimumReserveByWeapon);
      const deficit = Math.max(0, entry.planned - available);
      return { ...entry, reserve: filters.minimumReserveByWeapon, available, remaining: available - entry.planned, deficit };
    });
    const conflicts = [];
    for (const row of inventoryRows.filter(row => row.deficit)) {
      conflicts.push(`${row.platform} / ${row.weapon}: available = ${row.available}; planned = ${row.planned}; deficit = ${row.deficit}.`);
    }
    if (!packageData.permitDuplicateTargets) {
      for (const [target, count] of targets) if (count > 1) conflicts.push(`${target}: ${count} engagements assigned; only one is permitted.`);
    }
    for (const result of results) {
      conflicts.push(...result.failures.map(failure => `${result.candidate.id}: ${failure}`));
      if (inventoryRows.some(row => row.deficit && row.weapon === result.candidate.weapon &&
          candidateAllocations(result.candidate).some(([name]) => name === row.platform)) ||
          (!packageData.permitDuplicateTargets && targets.get(result.candidate.targetPlatform) > 1)) result.status = "conflict";
      else if (packageData.permitDuplicateTargets && targets.get(result.candidate.targetPlatform) > 1 && result.status === "feasible") result.status = "warning";
    }
    return {
      scenarioChanged, results, inventory: inventoryRows, expenditures, conflicts,
      selectedCount: selected.length, targetCount: targets.size,
      standardCount: selected.filter(c => c.kind === "standard").length,
      hybridCount: selected.filter(c => c.kind === "hybrid").length,
      feasible: conflicts.length === 0
    };
  }

  return { validateAndNormalize, distanceMeters, defaultFilters, validateFilters, summarizeEngagements, generateCandidates, diagnosePair, filterAndSortCandidates, candidatesCsv, exportPackage, validateMissionPackage, createMissionPackage, evaluateMission };
}
const MissionData = createMissionData();

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
  const optimizer = initializeOptimizer(data, indexes);

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
    try {
      MissionData.validateFilters(filters);
      error.textContent = "";
    } catch (problem) {
      error.textContent = problem.message;
      optimizer.invalidate("Filters are invalid; apply valid filters before optimizing.");
      return;
    }
    optimizer.setFilters(filters);
  });
  form.requestSubmit();
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function initializeOptimizer(data, indexes) {
  const element = id => document.getElementById(id);
  let filters = null, worker = null, timer = null, workerUrl = null;
  let latest = null, started = 0, proposal = null, objectives = null;
  function stopWorker() {
    if (worker) worker.terminate();
    worker = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = null;
    element("optimize-start").disabled = false;
    element("optimize-cancel").disabled = true;
  }
  function clearResult() {
    proposal = null;
    element("optimize-save").disabled = true;
    for (const id of ["optimizer-summary", "optimizer-rows", "optimizer-inventory", "optimizer-audit"]) element(id).replaceChildren();
    element("optimizer-status").textContent = "";
    element("optimizer-filters").textContent = "";
    element("optimizer-error").textContent = "";
  }
  function addRow(parent, values) {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    }
    parent.append(row);
  }
  function renderProposalRows() {
    const rows = element("optimizer-rows");
    rows.replaceChildren();
    if (!proposal) return;
    const candidates = MissionData.filterAndSortCandidates(
      proposal.selectedCandidateSnapshots, "", element("optimizer-sort").value);
    const shooter = candidate => candidate.kind === "standard"
      ? candidate.shooterPlatform : `${candidate.shooterAPlatform} + ${candidate.shooterBPlatform}`;
    for (const candidate of candidates) {
      const allocation = candidate.kind === "standard" ? candidate.requiredQuantity : `${candidate.shooterAAllocatedQuantity} + ${candidate.shooterBAllocatedQuantity}`;
      addRow(rows, [candidate.id, candidate.kind, shooter(candidate), candidate.targetPlatform, candidate.weapon, allocation]);
    }
  }
  element("optimizer-sort").addEventListener("change", renderProposalRows);
  function finish(result) {
    stopWorker();
    clearResult();
    element("optimizer-progress").textContent = "Search finished.";
    element("optimizer-status").textContent = `Search status: ${result.status}${result.reason ? ` — ${result.reason}` : ""}.`;
    element("optimizer-filters").textContent = `Applied filters: ${JSON.stringify(filters)}`;
    const summary = element("optimizer-summary");
    const fields = [
      ["Targets covered", result.selected.length],
      ["Total weapon expenditure", result.expenditure],
      ["Distinct shooters", result.shooters],
      ["Objectives", `Maximum target coverage${objectives.minimizeExpenditure ? "; minimum expenditure" : ""}${objectives.minimizeShooters ? "; minimum shooters" : ""}`],
      ["Runtime", `${Math.round(result.runtimeMs)} ms`],
      ["Search nodes", result.nodes],
      ["Candidate pool / retained", `${result.inputCount}${result.poolComplete ? "" : " (partial)"} / ${result.retainedCount}${result.preprocessingComplete ? "" : " (partial)"}`],
      ["Pruned candidates", `${result.audit.length}${result.preprocessingComplete ? "" : " recorded so far"}`]
    ];
    for (const [label, value] of fields) {
      const term = document.createElement("dt"), description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      summary.append(term, description);
    }
    const audit = element("optimizer-audit");
    for (const entry of result.audit) {
      const item = document.createElement("li");
      item.textContent = `${entry.id}: ${entry.reason}; preferred candidate ${entry.retainedId}.`;
      audit.append(item);
    }
    if (!result.audit.length) {
      const item = document.createElement("li");
      item.textContent = "None recorded.";
      audit.append(item);
    }
    if (!result.selected.length) return;
    const candidatePackage = MissionData.createMissionPackage(data, filters, result.selected, false);
    const assessment = MissionData.evaluateMission(data, indexes, candidatePackage);
    if (!assessment.feasible) throw new Error(`Proposal failed mission validation: ${assessment.conflicts.join(" ")}`);
    proposal = candidatePackage;
    element("optimize-save").disabled = false;
    renderProposalRows();
    for (const item of assessment.inventory) {
      addRow(element("optimizer-inventory"), [item.platform, item.weapon, item.loaded, item.reserve, item.planned, item.remaining, item.deficit]);
    }
  }
  function fail(error) {
    stopWorker();
    clearResult();
    element("optimizer-progress").textContent = "Search failed.";
    element("optimizer-error").textContent = error.message;
  }
  function interrupted(reason) {
    const partial = latest || { selected: [], expenditure: 0, shooters: 0, nodes: 0, inputCount: 0, retainedCount: 0, audit: [] };
    try {
      finish({ ...partial, status: partial.selected.length ? "feasible but not proven optimal" : "limit reached",
        reason, runtimeMs: Date.now() - started });
    } catch (error) { fail(error); }
  }
  element("optimize-start").addEventListener("click", () => {
    stopWorker();
    clearResult();
    latest = null;
    started = Date.now();
    objectives = {
      minimizeExpenditure: element("optimize-expenditure").checked,
      minimizeShooters: element("optimize-shooters").checked
    };
    try {
      const source = `"use strict"; const SCENARIO_RULES = ${JSON.stringify(SCENARIO_RULES)};\n` +
        `${createMissionData.toString()}\n${createOptimizer.toString()}\n(${optimizerWorkerMain.toString()})();`;
      workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const active = new Worker(workerUrl);
      worker = active;
      element("optimize-start").disabled = true;
      element("optimize-cancel").disabled = false;
      element("optimizer-progress").textContent = "Starting worker...";
      active.onmessage = event => {
        if (worker !== active) return;
        const message = event.data;
        if (message.type === "progress") {
          latest = message.update;
          element("optimizer-progress").textContent = `${latest.phase}: ${latest.nodes} nodes, ${latest.selected.length} targets covered.`;
        } else if (message.type === "result") {
          latest = message.result;
          if (Date.now() - started >= 5000) interrupted("Wall-clock budget reached");
          else {
            try { finish(message.result); } catch (error) { fail(error); }
          }
        } else if (message.type === "error") fail(new Error(message.message));
      };
      active.onerror = event => {
        if (worker === active) fail(new Error(`Optimizer worker failed: ${event.message || "unknown error"}`));
      };
      active.postMessage({ data, filters, options: objectives });
      timer = setTimeout(() => interrupted("Wall-clock budget reached"), Math.max(0, 5000 - (Date.now() - started)));
    } catch (error) { fail(error); }
  });
  element("optimize-cancel").addEventListener("click", () => {
    if (worker) interrupted("Cancelled by user");
  });
  element("optimize-save").addEventListener("click", () => {
    if (proposal) downloadFile("optimizer-proposal.json", JSON.stringify(proposal, null, 2), "application/json");
  });
  return {
    invalidate(message) {
      stopWorker();
      clearResult();
      filters = null;
      element("optimizer-progress").textContent = message;
      element("optimize-start").disabled = true;
    },
    setFilters(applied) {
      stopWorker();
      clearResult();
      filters = applied;
      element("optimizer").hidden = false;
      element("optimizer-progress").textContent = "Applied filters changed; no current proposal.";
    }
  };
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
