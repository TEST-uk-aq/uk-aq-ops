function normalisedPollutantCode(value) {
  return String(value || "").trim().toLowerCase();
}

export function deduplicateCanonicalManifestDeclarations(parent, {
  connectorKey = "(unknown connector manifest)",
} = {}) {
  const declarations = [
    ...(Array.isArray(parent?.pollutant_manifests) ? parent.pollutant_manifests : []),
    ...(Array.isArray(parent?.child_manifests) ? parent.child_manifests : []),
  ];
  const uniqueDeclarations = [];
  const identitiesByKey = new Map();
  let duplicateCount = 0;

  for (const declaration of declarations) {
    const manifestKey = String(declaration?.manifest_key || "").trim();
    if (!manifestKey) {
      uniqueDeclarations.push(declaration);
      continue;
    }
    const pollutantCode = normalisedPollutantCode(declaration?.pollutant_code);
    const existing = identitiesByKey.get(manifestKey);
    if (existing) {
      if (existing.pollutant_code !== pollutantCode) {
        throw new Error(
          `Blocked dependency: canonical child key has conflicting pollutant identities in ${connectorKey}; `
          + `manifest_key=${manifestKey}; first=${existing.pollutant_code || "(missing)"}; `
          + `second=${pollutantCode || "(missing)"}`,
        );
      }
      duplicateCount += 1;
      continue;
    }
    identitiesByKey.set(manifestKey, { pollutant_code: pollutantCode });
    uniqueDeclarations.push(declaration);
  }

  return {
    duplicate_count: duplicateCount,
    parent: duplicateCount > 0
      ? {
        ...parent,
        pollutant_manifests: uniqueDeclarations,
        child_manifests: [],
      }
      : parent,
  };
}
