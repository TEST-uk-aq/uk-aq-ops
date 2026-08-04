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
