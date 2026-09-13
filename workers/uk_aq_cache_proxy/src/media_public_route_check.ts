import {
  handleMediaPublicRequest,
  MEDIA_PUBLIC_API_PATH,
  MEDIA_PUBLIC_HOMEPAGE_API_PATH,
  MEDIA_PUBLIC_HOMEPAGE_VERSION_API_PATH,
  type MediaPublicRouteEnv,
} from "./media_public_route.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const requested: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  requested.push(String(input));
  return new Response(JSON.stringify({ articles: [] }), { status: 200, headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  } });
};

try {
  const env: MediaPublicRouteEnv = { UK_AQ_MEDIA_PUBLIC_URL: "https://media.test/" };
  for (const [path, expected] of [
    [MEDIA_PUBLIC_API_PATH + "?limit=6", "https://media.test/articles?limit=6"],
    [MEDIA_PUBLIC_HOMEPAGE_VERSION_API_PATH, "https://media.test/articles/homepage/version"],
    [MEDIA_PUBLIC_HOMEPAGE_API_PATH + "?generation=12", "https://media.test/articles/homepage?generation=12"],
  ]) {
    const response = await handleMediaPublicRequest(new Request(`https://site.test${path}`), env);
    assert(response.status === 200, `expected successful relay for ${path}`);
    assert(requested.pop() === expected, `unexpected upstream for ${path}`);
  }
  const duplicate = await handleMediaPublicRequest(new Request(
    `https://site.test${MEDIA_PUBLIC_HOMEPAGE_API_PATH}?generation=12&generation=13`), env);
  assert(duplicate.status === 400, "duplicate homepage generation must be rejected");
  assert(requested.length === 0, "invalid homepage generation must not reach Media");
  const versionQuery = await handleMediaPublicRequest(new Request(
    `https://site.test${MEDIA_PUBLIC_HOMEPAGE_VERSION_API_PATH}?generation=12`), env);
  assert(versionQuery.status === 400, "homepage version must not accept query parameters");
  assert(requested.length === 0, "invalid version query must not reach Media");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Media public proxy route checks passed");
