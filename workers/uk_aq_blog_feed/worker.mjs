const FEED_URL = "https://ukairquality.substack.com/feed";
const PUBLICATION_URL = "https://ukairquality.substack.com";
const KV_KEY = "substack:rss:v1";
const AUTH_HEADER = "x-uk-aq-worker-http-secret";

const LIMITS = Object.freeze({
  browserRunEnvelopeBytes: 4_000_000,
  renderedBytes: 3_000_000,
  xmlNodes: 10_000,
  itemCount: 50,
  titleLength: 240,
  descriptionLength: 1_000,
  authorLength: 160,
  slugLength: 120,
  urlLength: 2_048,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const hasFeed = Boolean(await env.BLOG_FEED_KV.get(KV_KEY));
      return jsonResponse({ ok: true, cached_feed: hasFeed }, hasFeed ? 200 : 503, {
        "cache-control": "no-store",
      });
    }

    if (url.pathname === "/feed") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return readCachedFeed(env);
    }

    if (url.pathname === "/refresh") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!isAuthorised(request, env)) {
        return jsonResponse({ ok: false, error: "unauthorised" }, 401, {
          "cache-control": "no-store",
        });
      }
      return refreshFeed(env);
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404, {
      "cache-control": "no-store",
    });
  },
};

async function readCachedFeed(env) {
  const raw = await env.BLOG_FEED_KV.get(KV_KEY);
  if (!raw) {
    return jsonResponse({ ok: false, error: "feed_not_initialised" }, 503, {
      "cache-control": "no-store",
    });
  }

  try {
    validateNormalisedFeed(JSON.parse(raw));
  } catch {
    return jsonResponse({ ok: false, error: "cached_feed_invalid" }, 503, {
      "cache-control": "no-store",
    });
  }

  return new Response(raw, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-if-error=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

async function refreshFeed(env) {
  try {
    if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") {
      throw new Error("Browser Run binding is unavailable");
    }
    if (!env.BLOG_FEED_KV || typeof env.BLOG_FEED_KV.put !== "function") {
      throw new Error("Blog feed KV binding is unavailable");
    }

    const response = await env.BROWSER.quickAction("content", {
      url: FEED_URL,
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
    });
    if (!response || typeof response.text !== "function") {
      throw new Error("Browser Run returned an unexpected response");
    }
    if (!response.ok) {
      throw new Error(`Browser Run returned HTTP ${response.status}`);
    }

    const rendered = await readBrowserRunRenderedContent(response);
    const rssSource = extractRssSource(rendered);
    const candidate = normaliseRss(rssSource);
    validateNormalisedFeed(candidate);

    const payload = JSON.stringify(candidate);
    await env.BLOG_FEED_KV.put(KV_KEY, payload);

    return jsonResponse(
      { ok: true, contract_version: candidate.contract_version, post_count: candidate.posts.length },
      200,
      { "cache-control": "no-store" },
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error("UK AQ Blog feed refresh failed:", message);
    return jsonResponse({ ok: false, error: "refresh_failed", message }, 502, {
      "cache-control": "no-store",
    });
  }
}

function isAuthorised(request, env) {
  const expected = typeof env.UK_AQ_BLOG_WORKER_HTTP_SECRET === "string"
    ? env.UK_AQ_BLOG_WORKER_HTTP_SECRET
    : "";
  const supplied = request.headers.get(AUTH_HEADER) || "";
  if (!expected || !supplied || expected.length !== supplied.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}

async function readBrowserRunRenderedContent(response) {
  const contentType = String(response.headers.get("content-type") || "").trim();
  if (contentType && !isJsonContentType(contentType)) {
    throw new Error("Browser Run returned a non-JSON content type");
  }

  const envelopeText = await readBoundedText(
    response,
    LIMITS.browserRunEnvelopeBytes,
    "Browser Run response",
  );
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new Error("Browser Run response body is not valid JSON");
  }

  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Browser Run response body is not a JSON object");
  }
  if (envelope.success !== true) {
    throw new Error(
      envelope.success === false
        ? "Browser Run content action reported failure"
        : "Browser Run response has an unexpected success value",
    );
  }
  if (typeof envelope.result !== "string") {
    throw new Error("Browser Run response result is missing or is not text");
  }
  if (!envelope.result.trim()) {
    throw new Error("Browser Run response result is empty");
  }
  if (new TextEncoder().encode(envelope.result).byteLength > LIMITS.renderedBytes) {
    throw new Error("Browser Run rendered result exceeds the feed-size limit");
  }
  return envelope.result;
}

function isJsonContentType(rawValue) {
  const mediaType = rawValue.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readBoundedText(response, maximumBytes, label) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`${label} exceeds the feed-size limit`);
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new Error(`${label} exceeds the feed-size limit`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel("feed-size limit exceeded");
      throw new Error(`${label} exceeds the feed-size limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function extractRssSource(rendered) {
  const marker = /<([a-z][\w:-]*)\b[^>]*\bid\s*=\s*(["'])webkit-xml-viewer-source-xml\2[^>]*>/i.exec(rendered);
  if (!marker) {
    throw new Error("Chromium XML viewer source marker was not found");
  }

  const sourceRegion = rendered.slice(marker.index + marker[0].length);
  const rawRssStart = sourceRegion.search(/<rss\b/i);
  if (rawRssStart >= 0) return sourceRegion.slice(rawRssStart);

  const escapedRssStart = sourceRegion.search(/&lt;rss\b/i);
  if (escapedRssStart < 0) {
    throw new Error("Chromium XML viewer did not contain an RSS document");
  }
  const escapedRssEnd = sourceRegion.toLowerCase().indexOf("&lt;/rss&gt;", escapedRssStart);
  if (escapedRssEnd < 0) {
    throw new Error("Chromium XML viewer contained an incomplete escaped RSS document");
  }
  const escaped = sourceRegion.slice(escapedRssStart, escapedRssEnd + "&lt;/rss&gt;".length);
  return decodeHtmlSource(escaped);
}

function normaliseRss(rssSource) {
  const root = parseXmlDocument(rssSource);
  if (root.name !== "rss") throw new Error("Feed root is not rss");

  const channel = childElements(root, "channel")[0];
  if (!channel) throw new Error("RSS channel is missing");

  normalisePlainText(childText(channel, "title"), LIMITS.titleLength, "channel title");
  const channelLink = childText(channel, "link").trim();
  validatePublicationIdentity(channelLink);

  const items = childElements(channel, "item");
  if (!items.length) throw new Error("RSS channel contains no posts");
  if (items.length > LIMITS.itemCount) {
    throw new Error(`RSS item count exceeds ${LIMITS.itemCount}`);
  }

  const posts = [];
  for (const item of items) {
    try {
      posts.push(normaliseItem(item));
    } catch (error) {
      console.warn("Skipping invalid UK AQ Blog RSS item:", safeErrorMessage(error));
    }
  }
  if (!posts.length) throw new Error("RSS channel contains no valid UK AQ posts");

  posts.sort((left, right) => {
    const dateOrder = right.published_at.localeCompare(left.published_at);
    return dateOrder || left.slug.localeCompare(right.slug);
  });

  const seenSlugs = new Set();
  const seenUrls = new Set();
  for (const post of posts) {
    if (seenSlugs.has(post.slug) || seenUrls.has(post.canonical_url)) {
      throw new Error("RSS channel contains duplicate post identities");
    }
    seenSlugs.add(post.slug);
    seenUrls.add(post.canonical_url);
  }

  return {
    contract_version: 1,
    source: "substack_rss",
    publication_url: PUBLICATION_URL,
    posts,
  };
}

function normaliseItem(item) {
  const canonicalUrl = validateCanonicalArticleUrl(childText(item, "link"));
  const slug = new URL(canonicalUrl).pathname.slice("/p/".length);
  const title = normalisePlainText(childText(item, "title"), LIMITS.titleLength, "post title");
  const description = normalisePlainText(
    childText(item, "description"),
    LIMITS.descriptionLength,
    "post description",
  );
  const guid = boundedRequiredText(childText(item, "guid"), LIMITS.urlLength, "post guid");
  const author = normalisePlainText(childText(item, "dc:creator"), LIMITS.authorLength, "post author");
  const publishedAt = normalisePublishedAt(childText(item, "pubDate"));

  const enclosure = childElements(item, "enclosure")[0];
  const rawImageUrl = enclosure?.attributes?.url || "";
  const imageUrl = rawImageUrl ? validateHttpsUrl(rawImageUrl, "post image URL") : null;

  return {
    slug,
    title,
    description,
    canonical_url: canonicalUrl,
    guid,
    author,
    published_at: publishedAt,
    image_url: imageUrl,
  };
}

function validatePublicationIdentity(rawUrl) {
  const publication = new URL(boundedRequiredText(rawUrl, LIMITS.urlLength, "publication URL"));
  if (
    publication.protocol !== "https:"
    || publication.hostname !== "ukairquality.substack.com"
    || publication.port
    || publication.username
    || publication.password
    || (publication.pathname !== "/" && publication.pathname !== "")
    || publication.search
    || publication.hash
  ) {
    throw new Error("RSS channel is not the canonical UK AQ publication");
  }
}

function validateCanonicalArticleUrl(rawUrl) {
  const text = boundedRequiredText(rawUrl, LIMITS.urlLength, "canonical article URL");
  const url = new URL(text);
  if (
    url.protocol !== "https:"
    || url.hostname !== "ukairquality.substack.com"
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("Post link is not a canonical UK AQ Substack URL");
  }
  const match = /^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname);
  if (!match || match[1].length > LIMITS.slugLength) {
    throw new Error("Post link does not contain a safe /p/<slug> path");
  }
  return url.href;
}

function validateHttpsUrl(rawUrl, fieldName) {
  const text = boundedRequiredText(rawUrl, LIMITS.urlLength, fieldName);
  const url = new URL(text);
  if (url.protocol !== "https:" || !url.hostname || url.port || url.username || url.password) {
    throw new Error(`${fieldName} must be an absolute HTTPS URL`);
  }
  return url.href;
}

function normalisePublishedAt(rawValue) {
  const text = boundedRequiredText(rawValue, 100, "publication date");
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error("Publication date is invalid");
  return new Date(timestamp).toISOString();
}

function validateNormalisedFeed(feed) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) throw new Error("Feed must be an object");
  if (feed.contract_version !== 1 || feed.source !== "substack_rss" || feed.publication_url !== PUBLICATION_URL) {
    throw new Error("Feed contract identity is invalid");
  }
  if (!Array.isArray(feed.posts) || !feed.posts.length || feed.posts.length > LIMITS.itemCount) {
    throw new Error("Feed post list is invalid");
  }

  const allowedFeedKeys = ["contract_version", "source", "publication_url", "posts"];
  if (!hasOnlyKeys(feed, allowedFeedKeys)) throw new Error("Feed contains unsupported fields");

  const allowedPostKeys = [
    "slug",
    "title",
    "description",
    "canonical_url",
    "guid",
    "author",
    "published_at",
    "image_url",
  ];
  let previousDate = null;
  const slugs = new Set();
  for (const post of feed.posts) {
    if (!post || typeof post !== "object" || Array.isArray(post) || !hasOnlyKeys(post, allowedPostKeys)) {
      throw new Error("Feed post shape is invalid");
    }
    const canonicalUrl = validateCanonicalArticleUrl(post.canonical_url);
    if (post.slug !== new URL(canonicalUrl).pathname.slice("/p/".length) || slugs.has(post.slug)) {
      throw new Error("Feed post identity is invalid");
    }
    slugs.add(post.slug);
    boundedRequiredText(post.title, LIMITS.titleLength, "post title");
    boundedRequiredText(post.description, LIMITS.descriptionLength, "post description");
    boundedRequiredText(post.guid, LIMITS.urlLength, "post guid");
    boundedRequiredText(post.author, LIMITS.authorLength, "post author");
    if (new Date(post.published_at).toISOString() !== post.published_at) {
      throw new Error("Feed publication time is not canonical ISO-8601 UTC");
    }
    if (previousDate && post.published_at > previousDate) throw new Error("Feed posts are not newest first");
    previousDate = post.published_at;
    if (post.image_url !== null) validateHttpsUrl(post.image_url, "post image URL");
  }
  return feed;
}

function parseXmlDocument(source) {
  let index = 0;
  let nodeCount = 0;
  let root = null;
  const stack = [];

  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      index = skipUntil(source, index + 4, "-->", "XML comment");
      continue;
    }
    if (source.startsWith("<?", index)) {
      index = skipUntil(source, index + 2, "?>", "XML processing instruction");
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) throw new Error("RSS contains unterminated CDATA");
      if (!stack.length) throw new Error("RSS contains CDATA outside the root element");
      stack[stack.length - 1].text += source.slice(index + 9, end);
      index = end + 3;
      continue;
    }
    if (/^<!doctype\b/i.test(source.slice(index, index + 10))) {
      throw new Error("RSS DOCTYPE declarations are not accepted");
    }
    if (source.startsWith("</", index)) {
      const end = source.indexOf(">", index + 2);
      if (end < 0) throw new Error("RSS contains an unterminated closing tag");
      const name = source.slice(index + 2, end).trim().toLowerCase();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error("RSS XML tags are unbalanced");
      index = end + 1;
      if (!stack.length) return root;
      continue;
    }
    if (source[index] === "<") {
      const end = findTagEnd(source, index + 1);
      const rawTag = source.slice(index + 1, end);
      const selfClosing = /\/\s*$/.test(rawTag);
      const parsed = parseStartTag(selfClosing ? rawTag.replace(/\/\s*$/, "") : rawTag);
      nodeCount += 1;
      if (nodeCount > LIMITS.xmlNodes) throw new Error("RSS XML node count exceeds the limit");
      const node = { name: parsed.name, attributes: parsed.attributes, text: "", children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) throw new Error("RSS contains more than one root element");
      else root = node;
      if (!selfClosing) stack.push(node);
      index = end + 1;
      if (selfClosing && !stack.length && root) return root;
      continue;
    }

    const nextTag = source.indexOf("<", index);
    const end = nextTag < 0 ? source.length : nextTag;
    const text = source.slice(index, end);
    if (stack.length) stack[stack.length - 1].text += decodeXmlEntities(text);
    else if (text.trim()) throw new Error("RSS contains text outside the root element");
    index = end;
  }

  throw new Error("RSS XML document is incomplete");
}

function parseStartTag(rawTag) {
  const nameMatch = /^\s*([A-Za-z_][\w.:-]*)/.exec(rawTag);
  if (!nameMatch) throw new Error("RSS contains an invalid start tag");
  const name = nameMatch[1].toLowerCase();
  const attributes = {};
  let cursor = nameMatch[0].length;

  while (cursor < rawTag.length) {
    while (/\s/.test(rawTag[cursor] || "")) cursor += 1;
    if (cursor >= rawTag.length) break;
    const attributeMatch = /^([A-Za-z_][\w.:-]*)\s*=\s*(["'])/.exec(rawTag.slice(cursor));
    if (!attributeMatch) throw new Error("RSS contains an invalid attribute");
    const attributeName = attributeMatch[1].toLowerCase();
    const quote = attributeMatch[2];
    cursor += attributeMatch[0].length;
    const valueEnd = rawTag.indexOf(quote, cursor);
    if (valueEnd < 0) throw new Error("RSS contains an unterminated attribute");
    if (Object.hasOwn(attributes, attributeName)) throw new Error("RSS contains a duplicate attribute");
    attributes[attributeName] = decodeXmlEntities(rawTag.slice(cursor, valueEnd));
    cursor = valueEnd + 1;
  }
  return { name, attributes };
}

function findTagEnd(source, startIndex) {
  let quote = null;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new Error("RSS contains an unterminated start tag");
}

function childElements(node, name) {
  return node.children.filter((child) => child.name === name.toLowerCase());
}

function childText(node, name) {
  const child = childElements(node, name)[0];
  return child ? nodeText(child) : "";
}

function nodeText(node) {
  return node.text + node.children.map(nodeText).join("");
}

function normalisePlainText(rawValue, maximumLength, fieldName) {
  const withoutMarkup = String(rawValue || "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlSource(withoutMarkup).replace(/\s+/g, " ").trim();
  return boundedRequiredText(decoded, maximumLength, fieldName);
}

function boundedRequiredText(rawValue, maximumLength, fieldName) {
  if (typeof rawValue !== "string") throw new Error(`${fieldName} must be text`);
  const text = rawValue.trim();
  if (!text) throw new Error(`${fieldName} is missing`);
  if (text.length > maximumLength) throw new Error(`${fieldName} exceeds ${maximumLength} characters`);
  return text;
}

function decodeXmlEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const codePoint = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function decodeHtmlSource(value) {
  return decodeXmlEntities(value).replace(/&nbsp;/gi, "\u00a0").replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—");
}

function skipUntil(source, fromIndex, marker, label) {
  const end = source.indexOf(marker, fromIndex);
  if (end < 0) throw new Error(`RSS contains an unterminated ${label}`);
  return end + marker.length;
}

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key)) && allowedKeys.every((key) => Object.hasOwn(value, key));
}

function methodNotAllowed(allowedMethod) {
  return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, {
    allow: allowedMethod,
    "cache-control": "no-store",
  });
}

function jsonResponse(body, status, additionalHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...additionalHeaders,
    },
  });
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown refresh failure";
  return message.slice(0, 300);
}
