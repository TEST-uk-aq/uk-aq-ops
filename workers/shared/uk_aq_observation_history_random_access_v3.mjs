// @ts-nocheck -- shared Worker/Node v3 reader infrastructure.

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function positiveSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return number;
}

function normalizeSha256(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${fieldName} must be lower-case SHA-256`);
  }
  return normalized;
}

function normalizeEtag(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const unquoted = normalized.startsWith('"') && normalized.endsWith('"')
    ? normalized.slice(1, -1)
    : normalized;
  return unquoted || null;
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new TypeError("Range reader must return ArrayBuffer bytes");
}

function checksumHex(value) {
  if (value === undefined || value === null) return null;
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createObservationHistoryV3RangeBudget({
  maxRangeReads,
  maxBytesRequested,
}) {
  const maxReads = positiveSafeInteger(maxRangeReads, "maxRangeReads");
  const maxBytes = positiveSafeInteger(
    maxBytesRequested,
    "maxBytesRequested",
  );
  let rangeReads = 0;
  let bytesRequested = 0;

  const assertCapacity = (additionalReads, additionalBytes, label) => {
    const reads = nonNegativeSafeInteger(additionalReads, "additionalReads");
    const bytes = nonNegativeSafeInteger(additionalBytes, "additionalBytes");
    if (rangeReads + reads > maxReads) {
      throw new Error(
        `V3 range-read count budget exceeded before ${label}: ` +
          `${rangeReads + reads} > ${maxReads}`,
      );
    }
    if (bytesRequested + bytes > maxBytes) {
      throw new Error(
        `V3 range-byte budget exceeded before ${label}: ` +
          `${bytesRequested + bytes} > ${maxBytes}`,
      );
    }
  };

  return Object.freeze({
    assertCapacity,
    consume(length, label = "range read") {
      const bytes = positiveSafeInteger(length, "range length");
      assertCapacity(1, bytes, label);
      rangeReads += 1;
      bytesRequested += bytes;
    },
    snapshot() {
      return Object.freeze({
        range_reads: rangeReads,
        bytes_requested: bytesRequested,
        max_range_reads: maxReads,
        max_bytes_requested: maxBytes,
      });
    },
  });
}

export function createPinnedObservationHistoryV3RandomAccessFile({
  identity,
  objectMetadata,
  readRange,
  budget,
}) {
  if (typeof readRange !== "function") {
    throw new TypeError("Pinned v3 random-access file requires readRange");
  }
  if (!budget || typeof budget.consume !== "function") {
    throw new TypeError("Pinned v3 random-access file requires a range budget");
  }
  const key = String(identity?.key || "").trim();
  if (!key) throw new TypeError("Pinned v3 file key is required");
  const byteSize = positiveSafeInteger(identity?.byte_size, "file.byte_size");
  const expectedSha256 = normalizeSha256(identity?.sha256, "file.sha256");
  const expectedEtag = identity?.etag === undefined
    ? null
    : normalizeEtag(identity.etag);
  const actualSize = positiveSafeInteger(
    objectMetadata?.byte_size,
    "object.byte_size",
  );
  const actualSha256 = normalizeSha256(
    objectMetadata?.sha256,
    "object.sha256",
  );
  const actualEtag = normalizeEtag(objectMetadata?.etag);
  if (actualSize !== byteSize) {
    throw new Error(`Pinned v3 object byte-size mismatch: ${key}`);
  }
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Pinned v3 object SHA-256 mismatch: ${key}`);
  }
  if (expectedEtag && actualEtag !== expectedEtag) {
    throw new Error(`Pinned v3 object ETag mismatch: ${key}`);
  }

  return Object.freeze({
    key,
    byteLength: byteSize,
    sha256: expectedSha256,
    etag: actualEtag,
    identity_verified: true,
    async slice(start, end = byteSize) {
      const offset = nonNegativeSafeInteger(start, "range start");
      const exclusiveEnd = nonNegativeSafeInteger(end, "range end");
      if (exclusiveEnd <= offset || exclusiveEnd > byteSize) {
        throw new RangeError(`Pinned v3 range is outside file bounds: ${key}`);
      }
      if (offset === 0 && exclusiveEnd === byteSize) {
        throw new Error(`Whole-object Parquet read is prohibited: ${key}`);
      }
      const length = exclusiveEnd - offset;
      budget.consume(length, `range ${offset}:${exclusiveEnd} for ${key}`);
      const body = exactArrayBuffer(await readRange({
        key,
        offset,
        length,
        etag: actualEtag,
        sha256: expectedSha256,
        byte_size: byteSize,
      }));
      if (body.byteLength !== length) {
        throw new Error(
          `Pinned v3 range returned ${body.byteLength} bytes; expected ${length}: ${key}`,
        );
      }
      return body;
    },
  });
}

export async function createR2PinnedObservationHistoryV3RandomAccessFile({
  bucket,
  identity,
  budget,
  diagnostics,
}) {
  if (!bucket || typeof bucket.head !== "function" || typeof bucket.get !== "function") {
    throw new TypeError("V3 R2 random access requires an R2 bucket binding");
  }
  if (diagnostics) diagnostics.identity_head_reads += 1;
  const head = await bucket.head(identity.key);
  if (!head) throw new Error(`Pinned v3 Parquet object is missing: ${identity.key}`);
  // R2 HEAD exposes this checksum without reading the object body when the
  // canonical writer supplied sha256 on put(). It is required here: an ETag
  // alone is not a substitute for the index-owned physical SHA-256.
  const storedSha256 = checksumHex(head.checksums?.sha256);
  if (!storedSha256) {
    throw new Error(
      `Pinned v3 Parquet object lacks stored R2 SHA-256 metadata: ${identity.key}`,
    );
  }
  const verifiedEtag = normalizeEtag(head.etag || head.httpEtag);
  if (!verifiedEtag) {
    throw new Error(`Pinned v3 Parquet object lacks an R2 ETag: ${identity.key}`);
  }

  return createPinnedObservationHistoryV3RandomAccessFile({
    identity,
    objectMetadata: {
      byte_size: head.size,
      sha256: storedSha256,
      etag: verifiedEtag,
    },
    budget,
    readRange: async ({ key, offset, length, etag, byte_size: byteSize }) => {
      const object = await bucket.get(key, {
        onlyIf: { etagMatches: etag },
        range: { offset, length },
      });
      if (!object || typeof object.arrayBuffer !== "function" || !object.body) {
        throw new Error(`Pinned v3 R2 range generation changed: ${key}`);
      }
      if (Number(object.size) !== byteSize) {
        throw new Error(`Pinned v3 R2 range byte-size identity changed: ${key}`);
      }
      if (normalizeEtag(object.etag || object.httpEtag) !== etag) {
        throw new Error(`Pinned v3 R2 range ETag identity changed: ${key}`);
      }
      const responseSha256 = checksumHex(object.checksums?.sha256);
      if (responseSha256 && responseSha256 !== identity.sha256) {
        throw new Error(`Pinned v3 R2 range SHA-256 identity changed: ${key}`);
      }
      if (
        object.range &&
        (
          Number(object.range.offset) !== offset ||
          Number(object.range.length) !== length
        )
      ) {
        throw new Error(`Pinned v3 R2 returned a contradictory range: ${key}`);
      }
      return object.arrayBuffer();
    },
  });
}

export function createR2ObservationHistoryV3Source({ bucket }) {
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.head !== "function") {
    throw new TypeError("V3 observation history source requires an R2 bucket binding");
  }
  return Object.freeze({
    async getIndexObject({ key, maxBytes, diagnostics }) {
      const object = await bucket.get(key);
      if (!object) return null;
      const size = positiveSafeInteger(object.size, "index object size");
      if (size > maxBytes) {
        throw new Error(`V3 index object exceeds byte budget: ${key}`);
      }
      if (typeof object.arrayBuffer !== "function" || !object.body) {
        throw new Error(`V3 index object body is unavailable: ${key}`);
      }
      const body = exactArrayBuffer(await object.arrayBuffer());
      if (body.byteLength !== size) {
        throw new Error(`V3 index object byte-size mismatch: ${key}`);
      }
      return Object.freeze({ key, body, byte_size: size });
    },
    openParquetFile({ identity, budget, diagnostics }) {
      return createR2PinnedObservationHistoryV3RandomAccessFile({
        bucket,
        identity,
        budget,
        diagnostics,
      });
    },
  });
}

export function coalesceObservationHistoryV3ByteRanges(
  ranges,
  { maxGapBytes, maxMergedBytes },
) {
  const maxGap = nonNegativeSafeInteger(maxGapBytes, "maxGapBytes");
  const maxMerged = positiveSafeInteger(maxMergedBytes, "maxMergedBytes");
  const normalized = (Array.isArray(ranges) ? ranges : []).map((range, index) => {
    const start = nonNegativeSafeInteger(range?.start, `ranges[${index}].start`);
    const end = positiveSafeInteger(range?.end, `ranges[${index}].end`);
    if (end <= start) throw new RangeError("V3 byte range end must exceed start");
    return {
      id: String(range?.id ?? index),
      start,
      end,
    };
  }).sort((left, right) =>
    left.start - right.start || left.end - right.end ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  const merged = [];
  for (const range of normalized) {
    const current = merged.at(-1);
    const candidateEnd = current ? Math.max(current.end, range.end) : range.end;
    if (
      current &&
      range.start - current.end <= maxGap &&
      candidateEnd - current.start <= maxMerged
    ) {
      current.end = candidateEnd;
      current.members.push(range);
    } else {
      if (range.end - range.start > maxMerged) {
        throw new Error(`V3 byte range exceeds maximum merged size: ${range.id}`);
      }
      merged.push({
        start: range.start,
        end: range.end,
        members: [range],
      });
    }
  }
  return merged;
}

export async function readObservationHistoryV3ByteRanges({
  file,
  ranges,
  concurrency,
  budget,
}) {
  const normalizedConcurrency = positiveSafeInteger(concurrency, "concurrency");
  const totalBytes = ranges.reduce(
    (sum, range) => sum + (range.end - range.start),
    0,
  );
  budget.assertCapacity(ranges.length, totalBytes, `planned ranges for ${file.key}`);
  const blocks = Array(ranges.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= ranges.length) return;
      const range = ranges[index];
      blocks[index] = Object.freeze({
        start: range.start,
        end: range.end,
        members: range.members,
        buffer: await file.slice(range.start, range.end),
      });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(normalizedConcurrency, ranges.length) },
      worker,
    ),
  );
  return blocks;
}

export function createPrefetchedObservationHistoryV3AsyncBuffer({
  file,
  blocks,
}) {
  return Object.freeze({
    byteLength: file.byteLength,
    slice(start, end = file.byteLength) {
      const offset = nonNegativeSafeInteger(start, "prefetched range start");
      const exclusiveEnd = nonNegativeSafeInteger(
        end,
        "prefetched range end",
      );
      const block = blocks.find((candidate) =>
        candidate.start <= offset && exclusiveEnd <= candidate.end
      );
      if (!block) {
        throw new Error(
          `Hyparquet requested an unplanned v3 byte range: ${offset}:${exclusiveEnd}`,
        );
      }
      return block.buffer.slice(
        offset - block.start,
        exclusiveEnd - block.start,
      );
    },
  });
}
