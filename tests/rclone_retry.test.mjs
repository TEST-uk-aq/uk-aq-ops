import test from "node:test";
import assert from "node:assert/strict";

import {
  isRetryableRcloneError,
} from "../scripts/backup_r2/lib/rclone.mjs";

test("classifies transient Dropbox path/not_folder errors as retryable", () => {
  assert.equal(
    isRetryableRcloneError(new Error("Dropbox error: path/not_folder/..")),
    true,
  );
});

test("classifies transient Dropbox path/not_found errors as retryable", () => {
  assert.equal(
    isRetryableRcloneError(new Error("Dropbox error: path/not_found/..")),
    true,
  );
});

test("preserves the existing HTML-response retry classification", () => {
  assert.equal(
    isRetryableRcloneError(
      new Error("invalid character '<' looking for beginning of value"),
    ),
    true,
  );
});

test("does not retry permanent permission failures by default", () => {
  assert.equal(
    isRetryableRcloneError(new Error("Dropbox error: insufficient_space")),
    false,
  );
});
