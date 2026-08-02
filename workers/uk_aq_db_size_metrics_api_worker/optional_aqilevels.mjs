function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingR2ObjectMessage(value) {
  const message = String(value || "").trim().toLowerCase();
  if (!message) {
    return false;
  }
  const isNotFound = message.includes("r2 get failed (404)") || message.includes("http 404");
  const isMissingKey =
    message.includes("nosuchkey")
    || message.includes("specified key does not exist");
  return isNotFound && isMissingKey;
}

export function isExpectedMissingAqilevelsIndex(payload) {
  if (!isObject(payload)) {
    return false;
  }
  const error = String(payload.error || "").trim();
  const indexKeys = isObject(payload.index_keys) ? payload.index_keys : {};
  const aqilevelsKey = String(indexKeys.aqilevels || "").trim();
  if (!error || !aqilevelsKey || !error.includes(aqilevelsKey)) {
    return false;
  }
  return isMissingR2ObjectMessage(error);
}

export function normaliseOptionalAqilevelsCountsPayload(payload) {
  if (!isExpectedMissingAqilevelsIndex(payload)) {
    return payload;
  }

  const indexKeys = isObject(payload.index_keys) ? payload.index_keys : {};
  const aqilevelsKey = String(indexKeys.aqilevels || "").trim();
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((warning) => {
        const text = String(warning || "");
        return !(
          text.toLowerCase().includes("aqilevels index unavailable")
          && (text.includes(aqilevelsKey) || isMissingR2ObjectMessage(text))
        );
      })
    : [];

  const domains = isObject(payload.domains) ? payload.domains : {};
  const aqilevelsDomain = isObject(domains.aqilevels) ? domains.aqilevels : {};

  return {
    ...payload,
    source: "cloudflare_r2_history_index_partial",
    error: null,
    warnings,
    domains: {
      ...domains,
      aqilevels: {
        ...aqilevelsDomain,
        available: false,
        index_missing: true,
      },
    },
  };
}
