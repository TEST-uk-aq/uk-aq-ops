import assert from "node:assert/strict";
import test from "node:test";
import { assertHistoryBackupRemotes } from "../scripts/backup_r2/lib/history_backup_targets.mjs";

const env = {
  CFLARE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  CFLARE_R2_BUCKET: "history-sandbox",
  CFLARE_R2_ACCESS_KEY_ID: "synthetic-access-id",
  CFLARE_R2_SECRET_ACCESS_KEY: "synthetic-r2-secret",
  DROPBOX_APP_KEY: "synthetic-app-id",
  DROPBOX_APP_SECRET: "synthetic-app-secret",
  DROPBOX_REFRESH_TOKEN: "synthetic-refresh-token",
};
const providers = [
  { Name: "s3", Options: [{ Name: "secret_access_key", IsPassword: false, Sensitive: true }] },
  { Name: "dropbox", Options: [{ Name: "client_secret", IsPassword: false, Sensitive: true }] },
];
function config() {
  return {
    uk_aq_r2: {
      type: "s3", provider: "Cloudflare", endpoint: env.CFLARE_R2_ENDPOINT,
      access_key_id: env.CFLARE_R2_ACCESS_KEY_ID, secret_access_key: env.CFLARE_R2_SECRET_ACCESS_KEY,
    },
    uk_aq_dropbox: {
      type: "dropbox", client_id: env.DROPBOX_APP_KEY, client_secret: env.DROPBOX_APP_SECRET,
      token: JSON.stringify({ refresh_token: env.DROPBOX_REFRESH_TOKEN }),
    },
  };
}
function inspect(value = config(), metadata = providers) {
  return (_bin, args) => ({ status: 0, stdout: JSON.stringify(args[1] === "providers" ? metadata : value) });
}

test("credential guard accepts exact effective secrets used by the workflow", () => {
  assert.doesNotThrow(() => assertHistoryBackupRemotes({ env, run: inspect() }));
});

test("credential guard refuses either mismatched secret without disclosing it", () => {
  for (const [remote, field] of [["uk_aq_r2", "secret_access_key"], ["uk_aq_dropbox", "client_secret"]]) {
    const value = config();
    value[remote][field] = "contradictory-synthetic-secret";
    assert.throws(() => assertHistoryBackupRemotes({ env, run: inspect(value) }), (error) => {
      assert.match(error.message, /credential identity/);
      assert.equal(error.message.includes(value[remote][field]), false);
      assert.equal(error.message.includes(env.CFLARE_R2_SECRET_ACCESS_KEY), false);
      assert.equal(error.message.includes(env.DROPBOX_APP_SECRET), false);
      return true;
    });
  }
});

test("credential guard does not accept obscured text as an effective plain-string secret", () => {
  // Public synthetic obscured-looking input, not an actual credential.
  for (const [remote, field] of [["uk_aq_r2", "secret_access_key"], ["uk_aq_dropbox", "client_secret"]]) {
    const value = config();
    value[remote][field] = "MDEyMzQ1Njc4OWFiY2RlZl9vYnNjdXJlZF9maXh0dXJl";
    assert.throws(() => assertHistoryBackupRemotes({ env, run: inspect(value) }), /credential identity/);
  }
});

test("credential guard fails closed on password-encoded or unknown backend metadata", () => {
  for (const metadata of [[], [{ Name: "s3", Options: [] }],
    providers.map((p) => ({ ...p, Options: p.Options.map((o) => ({ ...o, IsPassword: true })) }))]) {
    assert.throws(() => assertHistoryBackupRemotes({ env, run: inspect(config(), metadata) }), /credential representation/);
  }
});

test("R2-only entrypoint checks its secret and safe diagnostics discard config output", () => {
  const value = config();
  value.uk_aq_r2.secret_access_key = "other-synthetic-secret";
  assert.throws(() => assertHistoryBackupRemotes({ env, dropbox: false, run: inspect(value) }), /credential identity/);
  assert.throws(() => assertHistoryBackupRemotes({ env, run: () => ({ status: 1, stderr: "must-never-appear", stdout: JSON.stringify(value) }) }), (error) => {
    assert.equal(error.message.includes("must-never-appear"), false);
    assert.equal(error.message.includes("synthetic"), false);
    return true;
  });
});
