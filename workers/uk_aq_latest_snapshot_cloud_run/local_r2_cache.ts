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
};

type LocalCacheHit = {
  body: Uint8Array;
  etag: string;
};

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
}: {
  enabled: boolean;
  directory: string;
}) {
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
