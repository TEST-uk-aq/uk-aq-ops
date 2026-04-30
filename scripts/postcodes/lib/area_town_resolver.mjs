import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const AREA_RULES_BY_COUNTRY = {
  E92000001: ["buasd24", "bua24", "parish", "osward", "oslaua"],
  W92000004: ["buasd24", "bua24", "parish", "osward", "oslaua"],
  S92000003: ["osward", "oslaua"],
  N92000002: ["osward", "oslaua"],
  default: ["osward", "oslaua", "bua24", "parish"],
};

export const AREA_SOURCE_LABELS = {
  buasd24: "buasd24_name",
  bua24: "bua24_name",
  parish: "parish_name",
  osward: "osward_name",
  oslaua: "oslaua_name",
};

const PSEUDO_CODE_PATTERN = /^[A-Z]99999999$/;
const AREA_TOWN_SEPARATOR = "\u0001";

const AREA_LOOKUP_SPECS = [
  {
    id: "buasd24",
    label: "BUASD24 code -> BUASD24 name",
    filePattern: /buasd.*names and codes/i,
    codeCandidates: ["BUASD24CD", "BUASD24_CODE"],
    nameCandidates: ["BUASD24NM", "BUASD24_NAME", "BUASD24NMW"],
  },
  {
    id: "bua24",
    label: "BUA24 code -> BUA24 name",
    filePattern: /\bbua\b.*names and codes/i,
    codeCandidates: ["BUA24CD", "BUA24_CODE"],
    nameCandidates: ["BUA24NM", "BUA24_NAME", "BUA24NMW"],
  },
  {
    id: "parish",
    label: "PARNCP code -> Parish/Community name",
    filePattern: /parish.*names and codes/i,
    codeCandidates: ["PARNCP25CD", "PARNCP24CD", "PARNCP23CD", "PARNCP22CD", "PARNCP21CD", "PARNCPCD", "PARISHCD"],
    nameCandidates: ["PARNCP25NM", "PARNCP24NM", "PARNCP23NM", "PARNCP22NM", "PARNCP21NM", "PARNCPNM", "PARISHNM", "PARNCP25NMW", "PARNCP24NMW", "PARNCP23NMW", "PARNCP22NMW", "PARNCP21NMW"],
  },
  {
    id: "osward",
    label: "Ward code -> Ward name",
    filePattern: /ward names and codes uk/i,
    codeCandidates: ["WD25CD", "WD24CD", "WD23CD", "WD22CD", "WDCD"],
    nameCandidates: ["WD25NM", "WD24NM", "WD23NM", "WD22NM", "WDNM", "WD25NMW", "WD24NMW"],
  },
  {
    id: "oslaua",
    label: "LAD/UA code -> LA/UA name",
    filePattern: /(la_ua names and codes uk|lad local authority district names and codes uk)/i,
    codeCandidates: ["LAD25CD", "LAD24CD", "LAD23CD", "LAD22CD", "LADCD"],
    nameCandidates: ["LAD25NM", "LAD24NM", "LAD23NM", "LAD22NM", "LADNM", "LAD25NMW", "LAD24NMW", "LAD23NMW"],
  },
  {
    id: "ttwa",
    label: "TTWA code -> TTWA name",
    filePattern: /ttwa names and codes uk/i,
    codeCandidates: ["TTWA15CD", "TTWA11CD", "TTWACD", "TTWA_CODE"],
    nameCandidates: ["TTWA15NM", "TTWA11NM", "TTWANM", "TTWA_NAME"],
  },
  {
    id: "oscty",
    label: "County code -> County name",
    filePattern: /county names and codes uk/i,
    codeCandidates: ["CTY25CD", "CTY24CD", "CTY23CD", "CTYCD", "COUNTYCD"],
    nameCandidates: ["CTY25NM", "CTY24NM", "CTY23NM", "CTYNM", "COUNTYNM"],
  },
];

export function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values;
}

function clean(value) {
  return String(value || "").trim();
}

function normalizeHeaderName(value) {
  return clean(value)
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function chooseOptionalColumn(rawHeaders, candidates) {
  const normalized = rawHeaders.map(normalizeHeaderName);
  for (const candidate of candidates) {
    const target = normalizeHeaderName(candidate);
    const index = normalized.indexOf(target);
    if (index >= 0) {
      return {
        index,
        field: clean(rawHeaders[index]).replace(/^\uFEFF/, ""),
      };
    }
  }
  return {
    index: -1,
    field: null,
  };
}

function pickIndexByCandidates(headers, candidates) {
  const normalized = headers.map(normalizeHeaderName);
  for (const candidate of candidates) {
    const target = normalizeHeaderName(candidate);
    const idx = normalized.indexOf(target);
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

function readField(row, column) {
  if (!column || column.index < 0) {
    return "";
  }
  return clean(row[column.index]);
}

function readCode(row, column) {
  return readField(row, column).toUpperCase();
}

export function looksPseudoCode(value) {
  const compact = clean(value).toUpperCase();
  if (!compact || compact === "NULL" || compact === "N/A" || compact === "NA") {
    return true;
  }
  return PSEUDO_CODE_PATTERN.test(compact);
}

function parseDisplayTextOrNull(value) {
  const normalized = clean(value);
  return normalized || null;
}

function parseCodeOrNull(value) {
  const normalized = clean(value).toUpperCase();
  if (!normalized) {
    return null;
  }
  if (looksPseudoCode(normalized)) {
    return null;
  }
  return normalized;
}

function lookupName(lookupInfo, code) {
  if (!lookupInfo || lookupInfo.note !== "ok") {
    return null;
  }
  return lookupInfo.map.get(code) || null;
}

async function listLookupFiles(rootDir) {
  const output = [];

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!/\.(csv|txt)$/i.test(entry.name)) {
        continue;
      }
      output.push(filePath);
    }
  }

  await walk(rootDir);
  return output;
}

async function loadLookupMap(spec, files) {
  const filePath = files.find((candidate) => spec.filePattern.test(path.basename(candidate)));
  if (!filePath) {
    return {
      id: spec.id,
      label: spec.label,
      found: false,
      file_path: null,
      code_column: null,
      name_column: null,
      map: new Map(),
      row_count: 0,
      mapped_count: 0,
      note: "lookup_file_not_found",
    };
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  let headers = [];
  let codeIndex = -1;
  let nameIndex = -1;
  const map = new Map();
  let rowCount = 0;

  for await (const rawLine of rl) {
    lineNumber += 1;
    const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (!line.trim()) {
      continue;
    }
    if (lineNumber === 1) {
      headers = parseCsvLine(line).map(clean);
      codeIndex = pickIndexByCandidates(headers, spec.codeCandidates);
      nameIndex = pickIndexByCandidates(headers, spec.nameCandidates);
      continue;
    }

    rowCount += 1;
    if (codeIndex < 0 || nameIndex < 0) {
      continue;
    }
    const row = parseCsvLine(line);
    const code = clean(row[codeIndex]).toUpperCase();
    const name = clean(row[nameIndex]);
    if (!code || !name) {
      continue;
    }
    map.set(code, name);
  }

  return {
    id: spec.id,
    label: spec.label,
    found: true,
    file_path: filePath,
    code_column: codeIndex >= 0 ? headers[codeIndex] : null,
    name_column: nameIndex >= 0 ? headers[nameIndex] : null,
    map,
    row_count: rowCount,
    mapped_count: map.size,
    note: codeIndex < 0 || nameIndex < 0 ? "code_or_name_column_not_detected" : "ok",
  };
}

export function detectAreaTownColumns(rawHeaders) {
  return {
    ctry: chooseOptionalColumn(rawHeaders, ["ctry25cd", "ctry24cd", "ctry23cd", "ctry"]),
    buasd24: chooseOptionalColumn(rawHeaders, ["buasd24cd", "buasd24"]),
    bua24: chooseOptionalColumn(rawHeaders, ["bua24cd", "bua24"]),
    parish: chooseOptionalColumn(rawHeaders, ["parncp25cd", "parncp24cd", "parncp23cd", "parncp22cd", "parncp21cd", "parish"]),
    osward: chooseOptionalColumn(rawHeaders, ["wd25cd", "wd24cd", "wd23cd", "wd22cd", "osward"]),
    oslaua: chooseOptionalColumn(rawHeaders, ["lad25cd", "lad24cd", "lad23cd", "lad22cd", "lad21cd", "oslaua", "lad", "ladcd"]),
    ttwa: chooseOptionalColumn(rawHeaders, ["ttwa15cd", "ttwa11cd", "ttwa"]),
    oscty: chooseOptionalColumn(rawHeaders, ["cty25cd", "cty24cd", "cty23cd", "oscty"]),
    post_town: chooseOptionalColumn(rawHeaders, ["post_town", "posttown", "postal_town"]),
  };
}

export async function loadAreaTownLookups(onspdRoot) {
  const docsDir = path.join(onspdRoot, "Documents");
  const searchRoot = await fs.promises.stat(docsDir)
    .then((stat) => (stat.isDirectory() ? docsDir : onspdRoot))
    .catch(() => onspdRoot);
  const files = await listLookupFiles(searchRoot);

  const lookupInfos = [];
  for (const spec of AREA_LOOKUP_SPECS) {
    // eslint-disable-next-line no-await-in-loop
    lookupInfos.push(await loadLookupMap(spec, files));
  }
  const lookupById = new Map(lookupInfos.map((item) => [item.id, item]));
  return {
    lookupInfos,
    lookupById,
    lookup_root: searchRoot,
  };
}

export function resolveAreaAndPostTown({ row, columns, lookupById }) {
  const issues = [];
  const country = readCode(row, columns.ctry);
  const rawCodes = {
    buasd24: readCode(row, columns.buasd24),
    bua24: readCode(row, columns.bua24),
    parish: readCode(row, columns.parish),
    osward: readCode(row, columns.osward),
    oslaua: readCode(row, columns.oslaua),
    ttwa: readCode(row, columns.ttwa),
    oscty: readCode(row, columns.oscty),
  };

  const areaRuleIds = AREA_RULES_BY_COUNTRY[country] || AREA_RULES_BY_COUNTRY.default;
  let areaName = null;
  let areaSource = null;
  let areaCode = null;

  for (const lookupId of areaRuleIds) {
    const rawCode = rawCodes[lookupId];
    const code = parseCodeOrNull(rawCode);
    if (!code) {
      continue;
    }
    const lookup = lookupById.get(lookupId);
    if (!lookup || lookup.note !== "ok") {
      issues.push(`${lookupId}_lookup_unavailable`);
      continue;
    }
    const resolved = lookupName(lookup, code);
    if (!resolved) {
      issues.push(`${lookupId}_code_not_in_lookup`);
      continue;
    }
    areaName = parseDisplayTextOrNull(resolved);
    areaSource = AREA_SOURCE_LABELS[lookupId] || `${lookupId}_name`;
    areaCode = code;
    break;
  }

  const explicitPostTown = parseDisplayTextOrNull(readField(row, columns.post_town));
  let postTown = null;
  let postTownSource = null;
  let postTownCode = null;

  if (explicitPostTown) {
    postTown = explicitPostTown;
    postTownSource = "post_town_field";
    postTownCode = explicitPostTown;
  } else {
    if (!columns.post_town || columns.post_town.index < 0) {
      issues.push("no_post_town_field_found");
    }
    const postTownFallbackOrder = ["ttwa", "bua24", "oslaua", "oscty"];
    for (const lookupId of postTownFallbackOrder) {
      const rawCode = rawCodes[lookupId];
      const code = parseCodeOrNull(rawCode);
      if (!code) {
        continue;
      }
      const lookup = lookupById.get(lookupId);
      if (!lookup || lookup.note !== "ok") {
        issues.push(`${lookupId}_lookup_unavailable`);
        continue;
      }
      const resolved = lookupName(lookup, code);
      if (!resolved) {
        issues.push(`${lookupId}_code_not_in_lookup`);
        continue;
      }
      postTown = parseDisplayTextOrNull(resolved);
      postTownSource = `${lookupId}_fallback`;
      postTownCode = code;
      break;
    }
  }

  if (!areaName) {
    issues.push("missing_area_name");
  }
  if (!postTown) {
    issues.push("missing_post_town");
  }

  return {
    country_code: country || null,
    area_name: areaName,
    area_source: areaSource,
    area_code: areaCode,
    post_town: postTown,
    post_town_source: postTownSource,
    post_town_code: postTownCode,
    issues: Array.from(new Set(issues)),
  };
}

export function createAreaTownPairKey(areaName, postTown) {
  const area = parseDisplayTextOrNull(areaName) || "";
  const town = parseDisplayTextOrNull(postTown) || "";
  return `${area}${AREA_TOWN_SEPARATOR}${town}`;
}

export function parseAreaTownPairKey(key) {
  const [areaName = "", postTown = ""] = String(key || "").split(AREA_TOWN_SEPARATOR);
  return {
    area_name: parseDisplayTextOrNull(areaName),
    post_town: parseDisplayTextOrNull(postTown),
  };
}
