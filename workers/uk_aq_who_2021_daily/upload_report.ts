import { DEFAULT_REPORT_PATH, writeBoundedReport } from "./report.ts";

const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

function optionalEnv(name: string): string | null {
  const value = (Deno.env.get(name) || "").trim();
  return value || null;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizedRoot(value: string): string {
  const cleaned = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (!cleaned) throw new Error("UK_AQ_DROPBOX_ROOT must not be empty");
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function compactTimestamp(value: Date): string {
  return value.toISOString().replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/,
    "$1$2$3$4Z",
  );
}

function safeRunId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 100) || "local";
}

export function buildDropboxReportPath(args: {
  dropboxRoot: string;
  generatedAt: Date;
  workflowRunId: string;
}): string {
  const filename = `uk_aq_who_2021_daily_report_${
    compactTimestamp(args.generatedAt)
  }_${safeRunId(args.workflowRunId)}.json`;
  return `${normalizedRoot(args.dropboxRoot)}/who_2021/${filename}`;
}

async function accessToken(): Promise<string> {
  const appKey = requiredEnv("DROPBOX_APP_KEY");
  const appSecret = requiredEnv("DROPBOX_APP_SECRET");
  const refreshToken = requiredEnv("DROPBOX_REFRESH_TOKEN");
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
  if (!response.ok) {
    throw new Error(`Dropbox token request failed (${response.status})`);
  }
  const payload = await response.json();
  const token = String(payload?.access_token || "").trim();
  if (!token) throw new Error("Dropbox token response missing access_token");
  return token;
}

async function upload(
  token: string,
  path: string,
  body: string,
): Promise<Response> {
  return await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "overwrite",
        autorename: false,
        mute: true,
      }),
    },
    body,
  });
}

async function readReport(path: string): Promise<Record<string, unknown>> {
  const text = await Deno.readTextFile(path);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WHO report must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const reportPath = optionalEnv("UK_AQ_WHO_2021_REPORT_PATH") ||
    DEFAULT_REPORT_PATH;
  const report = await readReport(reportPath);
  const destinationPath = buildDropboxReportPath({
    dropboxRoot: requiredEnv("UK_AQ_DROPBOX_ROOT"),
    generatedAt: new Date(),
    workflowRunId: optionalEnv("GITHUB_RUN_ID") || "local",
  });
  const uploadedReport = {
    ...report,
    dropbox: {
      destination_path: destinationPath,
      upload_result: "uploaded",
    },
  };
  const body = `${JSON.stringify(uploadedReport, null, 2)}\n`;

  try {
    let token = await accessToken();
    let response = await upload(token, destinationPath, body);
    if (response.status === 401) {
      token = await accessToken();
      response = await upload(token, destinationPath, body);
    }
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Dropbox upload failed (${response.status}): ${
          responseText.slice(0, 500)
        }`,
      );
    }
    await writeBoundedReport(reportPath, uploadedReport);
    console.log(JSON.stringify({
      level: "info",
      event: "who_2021_report_uploaded",
      destination_path: destinationPath,
    }));
  } catch (error) {
    await writeBoundedReport(reportPath, {
      ...report,
      dropbox: {
        destination_path: destinationPath,
        upload_result: "failed",
      },
      operational_outcome: "failed",
      warnings: [
        ...(Array.isArray(report.warnings) ? report.warnings : []),
        "Dropbox report upload failed.",
      ],
      error: {
        message: error instanceof Error
          ? error.message.slice(0, 1000)
          : String(error).slice(0, 1000),
        source_file: "workers/uk_aq_who_2021_daily/upload_report.ts",
      },
    });
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "who_2021_report_upload_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    Deno.exit(1);
  }
}
