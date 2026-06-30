type DropboxErrorLogOptions = {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  dropboxRoot: string;
  serviceCode: string;
  payload: Record<string, unknown>;
};

const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

function normalizePath(value: string): string {
  const cleaned = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!cleaned) return "";
  const leading = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  return leading.length > 1 ? leading.replace(/\/+$/, "") : leading;
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") ||
    "service";
}

async function accessToken(
  appKey: string,
  appSecret: string,
  refreshToken: string,
): Promise<string> {
  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${appKey}:${appSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) throw new Error(`Dropbox token request failed (${response.status})`);
  const body = await response.json();
  const token = String(body?.access_token || "").trim();
  if (!token) throw new Error("Dropbox token response missing access_token");
  return token;
}

async function upload(token: string, path: string, body: string): Promise<Response> {
  return await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }),
    },
    body,
  });
}

export async function uploadDropboxErrorLog(
  options: DropboxErrorLogOptions,
): Promise<string | null> {
  if (!(options.appKey && options.appSecret && options.refreshToken)) return null;

  const createdAt = String(options.payload.created_at || new Date().toISOString());
  const errorId = String(options.payload.id || crypto.randomUUID());
  const root = normalizePath(options.dropboxRoot);
  const date = createdAt.slice(0, 10);
  const filename =
    `uk_aq_error_cloud_run_${safeCode(options.serviceCode)}_${compactTimestamp(createdAt)}_${errorId}.json`;
  const path = `${root}/error_log/${date}/${filename}`.replace(/\/{2,}/g, "/");
  const payload = { ...options.payload, id: errorId, created_at: createdAt, dropbox_path: path };
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  let token = await accessToken(options.appKey, options.appSecret, options.refreshToken);
  let response = await upload(token, path, body);
  if (response.status === 401) {
    token = await accessToken(options.appKey, options.appSecret, options.refreshToken);
    response = await upload(token, path, body);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropbox upload failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return path;
}
