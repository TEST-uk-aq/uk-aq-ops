import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboard = readFileSync("dashboard/assets/media.js", "utf8");
const hostedProxy = readFileSync(
  "workers/uk_aq_dashboard_online_api_worker/src/routes/media.ts", "utf8");
const localProxy = readFileSync(
  "local/dashboard/server/uk_aq_dashboard_media_proxy.py", "utf8");

assert.match(dashboard, /articles\/\$\{id\}\/image-policy/);
assert.match(dashboard, /headers\.set\("If-Match", String\(options\.revision\)\)/);
assert.match(dashboard, /permission_basis/);
assert.match(dashboard, /confirm_local_copy_permitted/);
assert.match(dashboard, /Existing article policies are not bulk-updated/);
assert.match(dashboard, /R2 object(?:s)? (?:is|are|will) not automatically deleted/);

const articlePolicyRoute = String.raw`^\/api\/media\/articles\/[1-9]\d*\/image-policy$`;
assert.ok(hostedProxy.includes(articlePolicyRoute));
assert.match(hostedProxy,
  /const maxBodyBytes = method === 'PUT' && ARTICLE_LOCAL_IMAGE_PATH\.test\(incoming\.pathname\)\s+\? MAX_LOCAL_IMAGE_UPLOAD_BYTES : MAX_BODY_BYTES/);
assert.ok(localProxy.includes('r"^/api/media/articles/[1-9]\\d*/image-policy$"'));
assert.match(localProxy,
  /MAX_LOCAL_IMAGE_UPLOAD_BYTES\s+if method == "PUT" and _ARTICLE_LOCAL_IMAGE_PATH\.fullmatch\(parsed\.path\)\s+else MAX_BODY_BYTES/);

console.log("Dashboard Media image policy checks passed");
