import { createHash } from "node:crypto";

export type LocalR2CacheStats = {
  enabled: boolean;
  cache_dir: string;
  disabled: number;
  cold_miss: number;
  warm_hit: number;
  fingerprint_mismatch: number;
  corrupt: number;
  validation_error: number;
  write_failure: number;
  skipped_missing_etag: number;
};

type LocalCacheSidecar = {
  schema_version: 1;
  key: string;
  etag: string;
  sha256: string;
};

type RemoteFingerprint = {
  exists: boolean;
  etag: string | null;
  sha256?: string | null;
  bytes?: number | null;
  last_modified?: string | null;
};

type LocalCacheHit = {
  body: Uint8Array;
  etag: string;
};

type EtagFormat = "quoted" | "unquoted" | "missing" | "malformed";

function classifyEtag(etag: string | null): { format: EtagFormat; value: string | null } {
  if (etag === null || etag === "") return { format: "missing", value: null };
  // A weak tag must never become equal to a strong tag by removing quotes.
  if (/^[Ww]\//.test(etag)) return { format: "malformed", value: null };
  if (/^"[^"\s\x00-\x1f\x7f]+"$/.test(etag)) {
    return { format: "quoted", value: etag.slice(1, -1) };
  }
  if (/^[^"\s\x00-\x1f\x7f]+$/.test(etag)) {
    return { format: "unquoted", value: etag };
  }
  return { format: "malformed", value: null };
}

function describeMalformedEtag(etag: string) {
  return {
    has_weak_etag_prefix: /^[Ww]\//.test(etag),
    has_leading_whitespace: /^\s/.test(etag),
    has_trailing_whitespace: /\s$/.test(etag),
    has_internal_whitespace: /\s/.test(etag.trim()),
    has_control_characters: /[\x00-\x1f\x7f]/.test(etag),
    has_non_ascii_characters: /[^\x00-\x7f]/.test(etag),
    starts_with_double_quote: etag.startsWith("\""),
    ends_with_double_quote: etag.endsWith("\""),
    double_quote_count: (etag.match(/"/g) || []).length,
    has_comma: etag.includes(","),
    character_length: Array.from(etag).length,
  };
}

function logEtagMismatch(
  key: string,
  remote: RemoteFingerprint,
  cachedEtag: string,
  cachedSha256: string,
  invocationId: string | null,
  readSequence: number,
): void {
  const cached = classifyEtag(cachedEtag);
  const remoteEtag = classifyEtag(remote.etag);
  const equalAfterQuoteNormalisation = cached.value !== null &&
    remoteEtag.value !== null && cached.value === remoteEtag.value;
  const mismatchCategory = !remote.exists
    ? "missing_remote"
    : cached.format === "missing" || remoteEtag.format === "missing"
    ? "missing_etag"
    : cached.format === "malformed" || remoteEtag.format === "malformed"
    ? "malformed_etag"
    : equalAfterQuoteNormalisation
    ? "quote_format_only"
    : "different_values";

  // Correlation only; weak validators remain ineligible for byte-exact cache reuse.
  const weakMatch = typeof remote.etag === "string"
    ? /^W\/"([^"\s\x00-\x1f\x7f]+)"$/.exec(remote.etag)
    : null;
  const weakOpaqueMatchesStrong = weakMatch && cached.format === "quoted"
    ? weakMatch[1] === cached.value
    : null;
  const remoteSha256Available = typeof remote.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(remote.sha256);
  const remoteBytes = typeof remote.bytes === "number" &&
      Number.isSafeInteger(remote.bytes) && remote.bytes >= 0
    ? remote.bytes
    : null;

  console.warn(JSON.stringify({
    event: "latest_snapshot_local_cache_etag_mismatch",
    invocation_id: invocationId,
    read_sequence: readSequence,
    weak_opaque_matches_cached_strong: weakOpaqueMatchesStrong,
    head_checksum_available: remoteSha256Available,
    head_checksum_matches_cached_sha256: remoteSha256Available
      ? remote.sha256 === cachedSha256 : null,
    head_bytes: remoteBytes,
    head_last_modified: remote.last_modified ?? null,
    key,
    remote_exists: remote.exists,
    cached_etag_format: cached.format,
    remote_etag_format: remoteEtag.format,
    equal_after_quote_normalisation: equalAfterQuoteNormalisation,
    mismatch_category: mismatchCategory,
    ...(remoteEtag.format === "malformed"
      ? { remote_etag_shape: describeMalformedEtag(remote.etag as string) }
      : {}),
  }));
}

function cacheFileStem(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

function parseSidecar(bytes: Uint8Array, key: string): LocalCacheSidecar | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LocalCacheSidecar> | null;
    if (
      !parsed ||
      parsed.schema_version !== 1 ||
      parsed.key !== key ||
      typeof parsed.etag !== "string" ||
      typeof parsed.sha256 !== "string"
    ) {
      return null;
    }
    const etag = parsed.etag.trim();
    const sha256 = parsed.sha256.trim().toLowerCase();
    return etag && /^[a-f0-9]{64}$/.test(sha256) ? { schema_version: 1, key, etag, sha256 } : null;
  } catch {
    return null;
  }
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeFile(temporaryPath, bytes);
    await Deno.rename(temporaryPath, path);
  } finally {
    try {
      await Deno.remove(temporaryPath);
    } catch {
      // The completed rename removes the temporary path on normal success.
    }
  }
}

export function createLatestSnapshotLocalR2Cache({
  enabled,
  directory,
  invocation_id = null,
}: {
  enabled: boolean;
  directory: string;
  invocation_id?: string | null;
}) {
  let readSequence = 0;
  const stats: LocalR2CacheStats = {
    enabled,
    cache_dir: directory,
    disabled: 0,
    cold_miss: 0,
    warm_hit: 0,
    fingerprint_mismatch: 0,
    corrupt: 0,
    validation_error: 0,
    write_failure: 0,
    skipped_missing_etag: 0,
  };

  function pathsFor(key: string) {
    const stem = cacheFileStem(key);
    return {
      body: `${directory}/${stem}.bin`,
      sidecar: `${directory}/${stem}.json`,
    };
  }

  return {
    async readValidated(
      key: string,
      loadRemoteFingerprint: () => Promise<RemoteFingerprint>,
      validateBody: (body: Uint8Array) => boolean,
    ): Promise<LocalCacheHit | null> {
      const currentReadSequence = ++readSequence;
      if (!enabled) {
        stats.disabled += 1;
        return null;
      }

      const paths = pathsFor(key);
      let sidecarBytes: Uint8Array;
      let body: Uint8Array;
      try {
        [sidecarBytes, body] = await Promise.all([
          Deno.readFile(paths.sidecar),
          Deno.readFile(paths.body),
        ]);
      } catch (error) {
        if (isNotFound(error)) {
          stats.cold_miss += 1;
        } else {
          stats.corrupt += 1;
        }
        return null;
      }

      const sidecar = parseSidecar(sidecarBytes, key);
      if (!sidecar) {
        stats.corrupt += 1;
        return null;
      }
      if (!validateBody(body)) {
        stats.corrupt += 1;
        return null;
      }
      if (sha256Hex(body) !== sidecar.sha256) {
        stats.corrupt += 1;
        return null;
      }

      let remote: RemoteFingerprint;
      try {
        remote = await loadRemoteFingerprint();
      } catch {
        stats.validation_error += 1;
        return null;
      }
      if (!remote.exists || !remote.etag || remote.etag !== sidecar.etag) {
        stats.fingerprint_mismatch += 1;
        logEtagMismatch(
          key, remote, sidecar.etag, sidecar.sha256, invocation_id, currentReadSequence,
        );
        return null;
      }

      stats.warm_hit += 1;
      return { body, etag: sidecar.etag };
    },

    async store(key: string, body: Uint8Array, etag: string | null): Promise<boolean> {
      if (!enabled) return true;
      const normalizedEtag = String(etag || "").trim();
      if (!normalizedEtag) {
        stats.skipped_missing_etag += 1;
        return false;
      }

      const paths = pathsFor(key);
      const sidecar = new TextEncoder().encode(JSON.stringify({
        schema_version: 1,
        key,
        etag: normalizedEtag,
        sha256: sha256Hex(body),
      } satisfies LocalCacheSidecar));
      try {
        await Deno.mkdir(directory, { recursive: true });
        await writeAtomically(paths.body, body);
        await writeAtomically(paths.sidecar, sidecar);
        return true;
      } catch {
        stats.write_failure += 1;
        return false;
      }
    },

    summary(): LocalR2CacheStats {
      return { ...stats };
    },
  };
}
