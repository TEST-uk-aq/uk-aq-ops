export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok\n", { status: 200, headers: { "cache-control": "no-store" } });
    }

    let target;
    if (url.pathname === "/feed") {
      target = "https://ukairquality.substack.com/feed";
    } else if (url.pathname === "/post") {
      target = "https://ukairquality.substack.com/p/introducing-uk-aq";
    } else {
      return new Response("Use /feed or /post\n", { status: 404 });
    }

    const upstream = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UKAQ-Substack-Phase2-Probe/1.0)",
        "Accept": url.pathname === "/feed"
          ? "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
    });

    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    headers.set("x-probe-upstream-status", String(upstream.status));
    headers.set("cache-control", "no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
