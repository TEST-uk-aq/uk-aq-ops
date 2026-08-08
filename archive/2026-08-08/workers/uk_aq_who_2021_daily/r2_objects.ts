export type R2Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type R2ObjectResult = {
  key: string;
  status: "updated" | "unchanged";
  bytes: number;
  comparison: "metadata_hash" | "existing_bytes" | "missing";
  logical_sha256: string;
};

export type R2ReadResult = {
  key: string;
  bytes: Uint8Array;
  etag: string | null;
  contentLength: number;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const LOGICAL_HASH_HEADER = "x-amz-meta-uk-aq-logical-sha256";

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function asBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? textBytes(value) : value;
}

export async function sha256Hex(
  value: Uint8Array | string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asBytes(value) as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(
  key: Uint8Array | string,
  value: string,
): Promise<Uint8Array> {
  const rawKey = typeof key === "string" ? textBytes(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      textBytes(value) as BufferSource,
    ),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function signedRequest(
  config: R2Config,
  method: "GET" | "HEAD" | "PUT",
  objectKey: string,
  body: Uint8Array | null,
  headers: Record<string, string> = {},
): Promise<{ url: string; headers: Record<string, string> }> {
  const endpoint = new URL(config.endpoint.replace(/\/$/, ""));
  const canonicalUri = `/${config.bucket}/${
    objectKey.split("/").filter(Boolean).map(encodePathPart).join("/")
  }`;
  const payloadHash = await sha256Hex(body || new Uint8Array());
  const stamp = amzDate(new Date());
  const dateStamp = stamp.slice(0, 8);
  const canonicalHeaderValues: Record<string, string> = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  for (const [name, value] of Object.entries(headers)) {
    canonicalHeaderValues[name.trim().toLowerCase()] = value.trim();
  }
  const headerEntries = Object.entries(canonicalHeaderValues).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const canonicalHeaders = headerEntries.map(([name, value]) =>
    `${name}:${value}`
  ).join("\n");
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const kDate = await hmacSha256(
    `AWS4${config.secretAccessKey}`,
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, config.region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hex(await hmacSha256(kSigning, stringToSign));
  const url = new URL(config.endpoint.replace(/\/$/, ""));
  url.pathname = canonicalUri;
  return {
    url: url.toString(),
    headers: {
      ...canonicalHeaderValues,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function fetchR2(
  config: R2Config,
  method: "GET" | "HEAD" | "PUT",
  objectKey: string,
  body: Uint8Array | null = null,
  headers: Record<string, string> = {},
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const signed = await signedRequest(
      config,
      method,
      objectKey,
      body,
      headers,
    );
    try {
      const response = await fetch(signed.url, {
        method,
        headers: signed.headers,
        body: body ? body as BodyInit : undefined,
      });
      if (
        response.ok ||
        !RETRYABLE_STATUS.has(response.status) ||
        attempt === MAX_ATTEMPTS
      ) {
        return response;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw new Error("R2 request retry loop exhausted");
}

export async function getR2Object(
  config: R2Config,
  objectKey: string,
): Promise<R2ReadResult> {
  const response = await fetchR2(config, "GET", objectKey);
  if (response.status === 404) {
    throw new Error(`R2 object not found: ${objectKey}`);
  }
  if (!response.ok) {
    throw new Error(`R2 GET failed for ${objectKey}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const rawDeclaredLength = response.headers.get("content-length");
  if (rawDeclaredLength !== null && rawDeclaredLength.trim() !== "") {
    const normalizedDeclaredLength = rawDeclaredLength.trim();
    if (!/^\d+$/.test(normalizedDeclaredLength)) {
      throw new Error(
        `Invalid R2 content-length for ${objectKey}: ${
          normalizedDeclaredLength.slice(0, 200)
        }`.slice(0, 500),
      );
    }
    const declaredLength = Number(normalizedDeclaredLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new Error(
        `Invalid R2 content-length for ${objectKey}: ${
          normalizedDeclaredLength.slice(0, 200)
        }`.slice(0, 500),
      );
    }
    if (declaredLength !== bytes.byteLength) {
      throw new Error(
        `R2 content-length mismatch for ${objectKey}: expected ${declaredLength}, read ${bytes.byteLength}`
          .slice(0, 500),
      );
    }
  }
  return {
    key: objectKey,
    bytes,
    etag: response.headers.get("etag"),
    contentLength: bytes.byteLength,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function existingObject(
  config: R2Config,
  objectKey: string,
): Promise<
  | { exists: false }
  | { exists: true; logicalHash: string | null; body: Uint8Array | null }
> {
  const head = await fetchR2(config, "HEAD", objectKey);
  if (head.status === 404) return { exists: false };
  if (!head.ok) {
    throw new Error(`R2 HEAD failed for ${objectKey}: HTTP ${head.status}`);
  }
  const logicalHash = head.headers.get(LOGICAL_HASH_HEADER);
  return { exists: true, logicalHash, body: null };
}

export async function putR2ObjectIfChanged(args: {
  config: R2Config;
  objectKey: string;
  body: Uint8Array | string;
  contentType: string;
  logicalHash?: string;
}): Promise<R2ObjectResult> {
  const body = asBytes(args.body);
  const logicalHash = args.logicalHash || await sha256Hex(body);
  const existing = await existingObject(args.config, args.objectKey);
  if (existing.exists && existing.logicalHash === logicalHash) {
    return {
      key: args.objectKey,
      status: "unchanged",
      bytes: body.byteLength,
      comparison: "metadata_hash",
      logical_sha256: logicalHash,
    };
  }

  if (existing.exists && !existing.logicalHash) {
    const get = await fetchR2(args.config, "GET", args.objectKey);
    if (!get.ok) {
      throw new Error(
        `R2 GET failed for ${args.objectKey}: HTTP ${get.status}`,
      );
    }
    const currentBody = new Uint8Array(await get.arrayBuffer());
    if (equalBytes(currentBody, body)) {
      return {
        key: args.objectKey,
        status: "unchanged",
        bytes: body.byteLength,
        comparison: "existing_bytes",
        logical_sha256: logicalHash,
      };
    }
  }

  const put = await fetchR2(args.config, "PUT", args.objectKey, body, {
    "content-type": args.contentType,
    "content-length": String(body.byteLength),
    [LOGICAL_HASH_HEADER]: logicalHash,
  });
  if (!put.ok) {
    const responseText = await put.text().catch(() => "");
    throw new Error(
      `R2 PUT failed for ${args.objectKey}: HTTP ${put.status} ${
        responseText.slice(0, 500)
      }`,
    );
  }
  return {
    key: args.objectKey,
    status: "updated",
    bytes: body.byteLength,
    comparison: existing.exists ? "existing_bytes" : "missing",
    logical_sha256: logicalHash,
  };
}
