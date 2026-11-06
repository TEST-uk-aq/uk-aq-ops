window.UKAQ_OPS_CONFIG = {
  "envName": "TEST",
  "apiBaseUrl": "/api",
  "dashboardTitle": "UK AQ Dashboard - TEST",
  "dashboardSubtitle": "Live snapshot of PM2.5, PM10, and NO2 freshness using timeseries last_value_at. Data updates from your local API.",
  "defaultRefreshSeconds": 300
};

(() => {
  if (window.__ukaqDashboardApiErrorPatchInstalled) return;
  window.__ukaqDashboardApiErrorPatchInstalled = true;

  const previousFetch = window.fetch.bind(window);

  function normaliseErrorValue(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";

    if (typeof value === "object") {
      const candidate = value.message || value.detail || value.code || value.error;
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      try {
        return JSON.stringify(value);
      } catch (_err) {
        return String(value);
      }
    }

    return String(value);
  }

  window.fetch = async (...args) => {
    const response = await previousFetch(...args);
    if (response.ok) return response;

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("json")) return response;

    try {
      const payload = await response.clone().json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return response;
      }

      const normalised = { ...payload };
      let changed = false;

      if (Object.prototype.hasOwnProperty.call(payload, "error") && typeof payload.error !== "string") {
        normalised.error = normaliseErrorValue(payload.error);
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, "message") && typeof payload.message !== "string") {
        normalised.message = normaliseErrorValue(payload.message);
        changed = true;
      }

      if (!changed) return response;

      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(normalised), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (_err) {
      return response;
    }
  };
})();











(() => {
  const STYLE_ID = "ukaq-freshness-table-layout-patch";
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .freshness-table thead th:first-child,
    .freshness-table tbody tr:not(.freshness-mobile-trend-row) > td:first-child {
      width: 31%;
    }

    .mode-view[data-mode="operations"] > [data-panel="service-egress"] {
      order: 999;
    }
  `;
  document.head.appendChild(style);
})();


(() => {
  // Local MySQL mode: the existing dashboard uses the same `force: true`
  // option for changing day/mode and for the explicit Refresh button. The
  // generated request represents that option as a `t` cache-buster. Only the
  // explicit Daily Tasks Refresh control should force a Supabase reconciliation;
  // ordinary Latest/All/date changes should be local MySQL reads.
  let forceNextDailyTaskSourceRefresh = false;
  const originalFetch = window.fetch.bind(window);

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("#daily-task-runs-refresh")
        : null;
      if (target) {
        forceNextDailyTaskSourceRefresh = true;
      }
    },
    true,
  );

  window.fetch = (input, init) => {
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : "";
    if (!rawUrl) {
      return originalFetch(input, init);
    }

    let url;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch (_err) {
      return originalFetch(input, init);
    }
    if (!url.pathname.endsWith("/daily_task_runs")) {
      return originalFetch(input, init);
    }

    // `t` is only a browser cache-buster. Removing it from ordinary local
    // view changes prevents the backend from mistaking those changes for an
    // authoritative source refresh.
    url.searchParams.delete("t");
    if (forceNextDailyTaskSourceRefresh) {
      forceNextDailyTaskSourceRefresh = false;
      url.searchParams.set("force", "1");
      url.searchParams.set("t", String(Date.now()));
    }

    return originalFetch(url.toString(), init);
  };
})();

