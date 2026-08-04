(() => {
  const requestedRanges = new Set();
  let scheduled = false;

  function normaliseDayKey(value) {
    const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }

  function parseDayKey(value) {
    const key = normaliseDayKey(value);
    if (!key) return null;
    const parsed = new Date(`${key}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function addUtcDays(value, count) {
    const next = new Date(value.getTime());
    next.setUTCDate(next.getUTCDate() + count);
    return next;
  }

  function dayKey(value) {
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString().slice(0, 10)
      : "";
  }

  function cellDateKey(cell) {
    return normaliseDayKey(cell.getAttribute("title"))
      || normaliseDayKey(cell.dataset.date || cell.dataset.day || "");
  }

  function hasR2Layer(cell) {
    return Boolean(cell.querySelector(
      ".coverage-bar-r2-observs, "
      + ".coverage-bar-r2-aqilevels, "
      + ".coverage-bar-dropbox-only-observs, "
      + ".coverage-bar-dropbox-only-aqilevels",
    ));
  }

  function hasOtherStorageLayer(cell) {
    return Boolean(cell.querySelector(
      ".coverage-bar-ingest, .coverage-bar-obsaqi-observs",
    ));
  }

  function contiguousRanges(keys) {
    const ordered = [...new Set(keys)].sort();
    if (!ordered.length) return [];

    const ranges = [];
    let start = ordered[0];
    let previous = parseDayKey(ordered[0]);

    for (let index = 1; index < ordered.length; index += 1) {
      const currentKey = ordered[index];
      const expectedKey = previous ? dayKey(addUtcDays(previous, 1)) : "";
      if (currentKey !== expectedKey) {
        ranges.push({ fromDay: start, toDay: dayKey(previous) });
        start = currentKey;
      }
      previous = parseDayKey(currentKey);
    }

    ranges.push({ fromDay: start, toDay: dayKey(previous) });
    return ranges;
  }

  function buildCountsUrl(fromDay, toDay) {
    const apiBase = String(
      window.UKAQ_OPS_CONFIG && window.UKAQ_OPS_CONFIG.apiBaseUrl
        ? window.UKAQ_OPS_CONFIG.apiBaseUrl
        : "/api",
    ).replace(/\/+$/, "");
    const url = new URL(`${apiBase}/r2_connector_counts`, window.location.href);
    url.searchParams.set("from_day", fromDay);
    url.searchParams.set("to_day", toDay);
    url.searchParams.set("grain", "day");
    url.searchParams.set("t", String(Date.now()));
    return url;
  }

  function requestMissingR2Days() {
    const todayKey = new Date().toISOString().slice(0, 10);
    const candidates = [];

    document.querySelectorAll(
      ".coverage-calendar-panel .coverage-day-cell",
    ).forEach((cell) => {
      const key = cellDateKey(cell);
      if (!key || key >= todayKey) return;
      if (hasR2Layer(cell)) return;
      if (!hasOtherStorageLayer(cell) && !cell.classList.contains("is-outside")) return;
      candidates.push(key);
    });

    contiguousRanges(candidates).forEach(({ fromDay, toDay }) => {
      const requestKey = `${fromDay}:${toDay}`;
      if (requestedRanges.has(requestKey)) return;
      requestedRanges.add(requestKey);

      window.fetch(buildCountsUrl(fromDay, toDay).toString(), {
        cache: "no-store",
      }).catch(() => {
        requestedRanges.delete(requestKey);
      });
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      requestMissingR2Days();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("focus", schedule);
  schedule();
})();
