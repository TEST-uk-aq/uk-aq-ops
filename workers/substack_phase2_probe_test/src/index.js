export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", { status: 200, headers: { "cache-control": "no-store" } });
    }

    const target = url.pathname === "/feed-browser"
      ? "https://ukairquality.substack.com/feed"
      : url.pathname === "/post-browser"
        ? "https://ukairquality.substack.com/p/introducing-uk-aq"
        : null;

    if (!target) {
      return new Response("Use /health, /feed-browser or /post-browser\n", { status: 404 });
    }

    try {
      const browserResponse = await env.BROWSER.quickAction("content", { url: target });
      const headers = new Headers(browserResponse.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-uk-aq-probe-source", "browser-run-content");
      return new Response(browserResponse.body, {
        status: browserResponse.status,
        headers,
      });
    } catch (error) {
      return new Response(
        `Browser Run failure: ${error instanceof Error ? error.message : String(error)}\n`,
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
      );
    }
  },
};
