const TILE_EPSILON = 1e-12;

function normalizeSignedZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

export function normalizePrefix(rawPrefix) {
  return String(rawPrefix || "").trim().replace(/^\/+|\/+$/g, "");
}

export function parseGridSize(rawValue, defaultValue = 0.05) {
  const value = Number.parseFloat(String(rawValue ?? "").trim());
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  if (value <= 0 || value > 90) {
    throw new Error(`Grid size must be > 0 and <= 90. Received: ${rawValue}`);
  }
  return value;
}

export function gridPrecision(gridSize) {
  const value = Number(gridSize);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid grid size for precision: ${gridSize}`);
  }
  let precision = 0;
  let scaled = value;
  while (precision < 8 && Math.abs(Math.round(scaled) - scaled) > 1e-9) {
    precision += 1;
    scaled = value * (10 ** precision);
  }
  return precision;
}

export function roundCoord(value, precision) {
  const rounded = Number(value.toFixed(precision));
  return normalizeSignedZero(rounded);
}

export function formatCoordToken(value, precision) {
  const rounded = roundCoord(value, precision);
  return rounded.toFixed(precision);
}

export function formatGridToken(gridSize) {
  const precision = gridPrecision(gridSize);
  return Number(gridSize).toFixed(precision);
}

export function buildTileKey(latMin, lonMin, precision) {
  return `${formatCoordToken(latMin, precision)}_${formatCoordToken(lonMin, precision)}`;
}

function buildTileIndexRange(minValue, maxValue, gridSize) {
  const start = Math.floor(minValue / gridSize) - 1;
  const end = Math.floor(maxValue / gridSize) + 1;
  const indices = [];
  for (let idx = start; idx <= end; idx += 1) {
    const tileMin = idx * gridSize;
    const tileMax = tileMin + gridSize;
    if (tileMax < minValue - TILE_EPSILON) {
      continue;
    }
    if (tileMin > maxValue + TILE_EPSILON) {
      continue;
    }
    indices.push(idx);
  }
  return indices;
}

export function tileForPoint(lat, lon, gridSize) {
  const precision = gridPrecision(gridSize);
  const latMin = roundCoord(Math.floor(lat / gridSize) * gridSize, precision);
  const lonMin = roundCoord(Math.floor(lon / gridSize) * gridSize, precision);
  const latMax = roundCoord(latMin + gridSize, precision);
  const lonMax = roundCoord(lonMin + gridSize, precision);
  return {
    key: buildTileKey(latMin, lonMin, precision),
    lat_min: latMin,
    lat_max: latMax,
    lon_min: lonMin,
    lon_max: lonMax,
  };
}

export function tilesForBbox(bbox, gridSize) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error(`Expected bbox array [minLon, minLat, maxLon, maxLat]. Received: ${bbox}`);
  }

  const [rawMinLon, rawMinLat, rawMaxLon, rawMaxLat] = bbox.map((value) => Number(value));
  if (
    !Number.isFinite(rawMinLon)
    || !Number.isFinite(rawMinLat)
    || !Number.isFinite(rawMaxLon)
    || !Number.isFinite(rawMaxLat)
  ) {
    throw new Error(`Invalid bbox numbers: ${bbox}`);
  }
  if (rawMaxLon < rawMinLon || rawMaxLat < rawMinLat) {
    throw new Error(`Invalid bbox ordering (max < min): ${bbox}`);
  }

  const precision = gridPrecision(gridSize);
  const latIndices = buildTileIndexRange(rawMinLat, rawMaxLat, gridSize);
  const lonIndices = buildTileIndexRange(rawMinLon, rawMaxLon, gridSize);
  const tiles = [];

  for (const latIdx of latIndices) {
    const latMin = roundCoord(latIdx * gridSize, precision);
    const latMax = roundCoord(latMin + gridSize, precision);
    for (const lonIdx of lonIndices) {
      const lonMin = roundCoord(lonIdx * gridSize, precision);
      const lonMax = roundCoord(lonMin + gridSize, precision);
      tiles.push({
        key: buildTileKey(latMin, lonMin, precision),
        lat_min: latMin,
        lat_max: latMax,
        lon_min: lonMin,
        lon_max: lonMax,
      });
    }
  }

  tiles.sort((left, right) => {
    if (left.lat_min !== right.lat_min) {
      return left.lat_min - right.lat_min;
    }
    return left.lon_min - right.lon_min;
  });

  return tiles;
}

export function bboxesOverlap(leftBbox, rightBbox) {
  if (!Array.isArray(leftBbox) || !Array.isArray(rightBbox) || leftBbox.length !== 4 || rightBbox.length !== 4) {
    return false;
  }
  return (
    Number(leftBbox[0]) <= Number(rightBbox[2]) + TILE_EPSILON
    && Number(leftBbox[2]) + TILE_EPSILON >= Number(rightBbox[0])
    && Number(leftBbox[1]) <= Number(rightBbox[3]) + TILE_EPSILON
    && Number(leftBbox[3]) + TILE_EPSILON >= Number(rightBbox[1])
  );
}

function normalizePropertyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isPresent(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

export function detectPropertyKeyFromFeatures(features, candidates, label) {
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error(`No features available for ${label} property detection.`);
  }

  const candidatePriority = new Map();
  candidates.forEach((candidate, index) => {
    const normalized = normalizePropertyName(candidate);
    if (normalized && !candidatePriority.has(normalized)) {
      candidatePriority.set(normalized, index);
    }
  });

  const scoreByKey = new Map();
  const availableKeys = new Set();

  for (const feature of features) {
    const properties = feature && typeof feature === "object" && feature.properties && typeof feature.properties === "object"
      ? feature.properties
      : null;
    if (!properties) {
      continue;
    }

    for (const [rawKey, rawValue] of Object.entries(properties)) {
      availableKeys.add(rawKey);
      const normalized = normalizePropertyName(rawKey);
      if (!candidatePriority.has(normalized)) {
        continue;
      }

      if (!scoreByKey.has(rawKey)) {
        scoreByKey.set(rawKey, {
          count: 0,
          priority: candidatePriority.get(normalized),
        });
      }
      if (isPresent(rawValue)) {
        const current = scoreByKey.get(rawKey);
        current.count += 1;
      }
    }
  }

  let bestKey = null;
  let bestCount = -1;
  let bestPriority = Number.POSITIVE_INFINITY;

  for (const [key, score] of scoreByKey.entries()) {
    if (score.count > bestCount) {
      bestKey = key;
      bestCount = score.count;
      bestPriority = score.priority;
      continue;
    }
    if (score.count === bestCount) {
      if (score.priority < bestPriority) {
        bestKey = key;
        bestPriority = score.priority;
        continue;
      }
      if (score.priority === bestPriority && String(key).localeCompare(String(bestKey)) < 0) {
        bestKey = key;
      }
    }
  }

  if (bestKey) {
    return bestKey;
  }

  const availablePreview = Array.from(availableKeys).sort((a, b) => a.localeCompare(b));
  throw new Error(
    `Unable to detect ${label} property. Candidates: ${candidates.join(", ")}. Available keys: ${availablePreview.join(", ")}`,
  );
}

export function normalizeFeatureRecord({ code, name, bbox, geometry }) {
  return {
    code: String(code || "").trim(),
    name: String(name || "").trim(),
    bbox,
    geometry,
  };
}
