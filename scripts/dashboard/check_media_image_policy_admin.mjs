import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboard = readFileSync("dashboard/assets/media.js", "utf8");
const hostedProxy = readFileSync(
  "workers/uk_aq_dashboard_online_api_worker/src/routes/media.ts", "utf8");
const localProxy = readFileSync(
  "local/dashboard/server/uk_aq_dashboard_media_proxy.py", "utf8");

assert.match(dashboard, /articles\/\$\{id\}\/image-policy/);
assert.match(dashboard, /headers\.set\("If-Match", String\(options\.revision\)\)/);
assert.match(dashboard, /confirm_local_copy_permitted/);
assert.match(dashboard, /Existing article policies are not bulk-updated/);
assert.match(dashboard, /R2 object(?:s)? (?:is|are|will) not automatically deleted/);

const articlePolicy = dashboard.slice(
  dashboard.indexOf("function articleImagePolicyHtml"),
  dashboard.indexOf("async function openArticle"));
assert.doesNotMatch(articlePolicy, /Permission\/basis note/);
assert.doesNotMatch(articlePolicy, /name="permission_basis"/);
assert.doesNotMatch(articlePolicy,
  /Article local_copy_permitted cannot be granted until source-wide local-copy permission/);
assert.match(articlePolicy, /confirm_local_copy_permitted/);

const sourcePolicy = dashboard.slice(
  dashboard.indexOf("function sourceImagePolicyHtml"),
  dashboard.indexOf("function sourceCard"));
assert.match(sourcePolicy, /Permission\/basis note/);
assert.match(sourcePolicy, /name="permission_basis"/);

const articleDetail = dashboard.slice(
  dashboard.indexOf('dialog.innerHTML = `<div class="media-detail__inner"><div class="media-detail__header"'),
  dashboard.indexOf('dialog.querySelector("[data-close-detail]")'));
const statusAt = articleDetail.indexOf("<h4>Article Status</h4>");
const authorAt = articleDetail.indexOf("<h4>Author</h4>");
const displayTitleAt = articleDetail.indexOf("<h4>Display title</h4>");
const imagePolicyAt = articleDetail.indexOf("$" + "{articleImagePolicyHtml(article)}");
const reloadMetadataAt = articleDetail.indexOf("<h4>Reload metadata</h4>");
assert.ok(statusAt >= 0 && statusAt < authorAt,
  "Article Status must be the first editable section after article info");
assert.ok(displayTitleAt >= 0 && displayTitleAt < imagePolicyAt && imagePolicyAt < reloadMetadataAt,
  "Image policy must sit between Display title and Reload metadata");

const articlePolicyRoute = String.raw`^\/api\/media\/articles\/[1-9]\d*\/image-policy$`;
assert.ok(hostedProxy.includes(articlePolicyRoute));
assert.match(hostedProxy,
  /const maxBodyBytes = method === 'PUT' && ARTICLE_LOCAL_IMAGE_PATH\.test\(incoming\.pathname\)\s+\? MAX_LOCAL_IMAGE_UPLOAD_BYTES : MAX_BODY_BYTES/);
assert.ok(localProxy.includes('r"^/api/media/articles/[1-9]\\d*/image-policy$"'));
assert.match(localProxy,
  /MAX_LOCAL_IMAGE_UPLOAD_BYTES\s+if method == "PUT" and _ARTICLE_LOCAL_IMAGE_PATH\.fullmatch\(parsed\.path\)\s+else MAX_BODY_BYTES/);

console.log("Dashboard Media image policy checks passed");
