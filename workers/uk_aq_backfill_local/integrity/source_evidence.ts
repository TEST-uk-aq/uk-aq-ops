/** Stable semantic serialization and hashing for Integrity source evidence. */

import { sha256Hex } from "../../shared/r2_sigv4.mjs";

export function canonicalSemanticJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSemanticJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalSemanticJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deterministicSemanticHash(value: unknown): string {
  return sha256Hex(canonicalSemanticJson(value));
}
