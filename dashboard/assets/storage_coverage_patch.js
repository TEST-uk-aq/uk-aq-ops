(() => {
  const DROPBOX_ICON_PATH = "assets/dropbox-icon.svg";

  const state = {
    coveragePayload: null,
    r2CountPresence: {
      observations: new Set(),
      aqilevels: new Set(),
      fromDay: null,
      toDay: null,
    },
    r2RequestToken: 0,
    revision: 0,
    scheduled: false,
  };

  function requestUrl(input) {
    const rawUrl = typeof input === "string"
      ? input
      : input && typeof input.url === "string"
        ? input.url
        : "";
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl, window.location.href);
    } catch (_err) {
      return null;
    }
  }

  function isStorageCoverageRequest(url) {
    return Boolean(url && url.pathname.includes("/storage_coverage"));
  }

  function isR2ConnectorCountsRequest(url) {
    return Boolean(url && url.pathname.includes("/r2_connector_counts"));
  }

  function scheduleEnhancement() {
    if (state.scheduled) return;
    state.scheduled = true;
    window.requestAnimationFrame(() => {
      state.scheduled = false;
      enhanceCoveragePanel();
    });
  }

  function injectStyles() {
    if (document.getElementById("ukaq-storage-coverage-patch-styles")) return;
    const style = document.createElement("style");
    style.id = "ukaq-storage-coverage-patch-styles";
    style.textContent = `
      .coverage-bar-slot.ukaq-storage-slot {
        width: 100%;
        gap: 0;
      }

      .coverage-bar-slot.ukaq-storage-slot > .coverage-bar {
        width: 100% !important;
        min-width: 0;
      }

      .coverage-bar-slot.ukaq-storage-slot > .coverage-bar.ukaq-today-bar {
        width: 50% !important;
      }

      .ukaq-storage-row-split {
        display: flex;
        width: 100%;
        height: 100%;
        min-height: 12px;
        gap: 4px;
      }

      .ukaq-storage-row-split.ukaq-today-split {
        width: 50%;
      }

      .ukaq-storage-row-split > .coverage-bar {
        flex: 1 1 0;
        width: auto !important;
        min-width: 0;
        justify-content: center;
      }

      .ukaq-storage-row-split .coverage-bar-label {
        justify-content: center;
      }

      .ukaq-split-dropbox-icon,
      .ukaq-today-dropbox-icon {
        display: block;
        width: 15px;
        height: 15px;
        object-fit: contain;
      }

      .ukaq-year-dropbox-icon {
        display: block;
        width: 70%;
        height: 70%;
        margin: 15%;
        object-fit: contain;
      }

      .ukaq-coverage-meta {
        margin-top: 8px;
      }

      .ukaq-coverage-warning {
        color: #9a1f1f;
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);
  }

  function utcLabel(value) {
    if (!value) return "unknown";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${formatter.format(parsed)} UTC`;
  }

  function normaliseDayKey(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }

  function parseDayKey(value) {
    const key = normaliseDayKey(value);
    if (!key) return null;
    const parsed = new Date(`${key}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function dayKey(value) {
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString().slice(0, 10)
      : "";
  }

  function addUtcDays(value, count) {
    const next = new Date(value.getTime());
    next.setUTCDate(next.getUTCDate() + count);
    return next;
  }

  function calendarGridRange(fromDay, toDay) {
    const from = parseDayKey(fromDay);
    const to = parseDayKey(toDay);
    if (!from || !to) return null;

    const fromMondayOffset = (from.getUTCDay() + 6) % 7;
    const toMondayOffset = (to.getUTCDay() + 6) % 7;
    return {
      fromDay: dayKey(addUtcDays(from, -fromMondayOffset)),
      toDay: dayKey(addUtcDays(to, 6 - toMondayOffset)),
    };
  }

  function todayUtcKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function rowMap(payload) {
    const rows = payload && Array.isArray(payload.storage_coverage_days)
      ? payload.storage_coverage_days
      : [];
    return new Map(
      rows
        .filter((row) => row && typeof row.date === "string")
        .map((row) => [normaliseDayKey(row.date), row]),
    );
  }

  function cellDateKey(cell) {
    const title = String(cell.getAttribute("title") || "");
    const titleKey = normaliseDayKey(title);
    if (titleKey) return titleKey;

    return normaliseDayKey(cell.dataset.date || cell.dataset.day || "");
  }

  function presenceFromPayload(payload) {
    const observations = new Set();
    const aqilevels = new Set();

    if (!payload || !Array.isArray(payload.connectors)) {
      return { observations, aqilevels };
    }

    payload.connectors.forEach((connector) => {
      const buckets = Array.isArray(connector && connector.buckets)
        ? connector.buckets
        : [];
      buckets.forEach((bucket) => {
        const key = normaliseDayKey(
          bucket && (bucket.bucket_start_day_utc || bucket.day_utc || bucket.bucket_key),
        );
        if (!key) return;

        if (Number(bucket && bucket.observations_rows || 0) > 0) {
          observations.add(key);
        }
        if (Number(bucket && bucket.aqilevels_rows || 0) > 0) {
          aqilevels.add(key);
        }
      });
    });

    return { observations, aqilevels };
  }

  function mergePresence(target, source) {
    source.observations.forEach((key) => target.observations.add(key));
    source.aqilevels.forEach((key) => target.aqilevels.add(key));
  }

  async function fetchAuxiliaryR2Presence(baseUrl, fromDay, toDay, token) {
    if (!fromDay || !toDay || fromDay > toDay) return;

    const url = new URL(baseUrl.toString());
    url.searchParams.set("from_day", fromDay);
    url.searchParams.set("to_day", toDay);
    url.searchParams.set("grain", "day");
    url.searchParams.set("t", String(Date.now()));

    try {
      const response = await originalFetch(url.toString(), { cache: "no-store" });
      if (!response.ok || token !== state.r2RequestToken) return;
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || token !== state.r2RequestToken) return;
      mergePresence(state.r2CountPresence, presenceFromPayload(payload));
      state.revision += 1;
      scheduleEnhancement();
    } catch (_err) {
      // The main calendar still uses the normal storage-coverage response.
    }
  }

  function updateR2CountPresence(payload, url) {
    if (!payload || !url) return;

    const grain = String(url.searchParams.get("grain") || "day").toLowerCase();
    if (grain !== "day") return;

    const fromDay = normaliseDayKey(url.searchParams.get("from_day"));
    const toDay = normaliseDayKey(url.searchParams.get("to_day"));
    const token = state.r2RequestToken + 1;
    state.r2RequestToken = token;

    const mainPresence = presenceFromPayload(payload);
    state.r2CountPresence = {
      observations: mainPresence.observations,
      aqilevels: mainPresence.aqilevels,
      fromDay,
      toDay,
    };

    const gridRange = calendarGridRange(fromDay, toDay);
    if (gridRange) {
      const parsedFromDay = parseDayKey(fromDay);
      const parsedToDay = parseDayKey(toDay);
      if (!parsedFromDay || !parsedToDay) return;
      const previousDay = dayKey(addUtcDays(parsedFromDay, -1));
      const nextDay = dayKey(addUtcDays(parsedToDay, 1));

      if (gridRange.fromDay < fromDay) {
        void fetchAuxiliaryR2Presence(url, gridRange.fromDay, previousDay, token);
      }
      if (gridRange.toDay > toDay) {
        void fetchAuxiliaryR2Presence(url, nextDay, gridRange.toDay, token);
      }
    }
  }

  function effectiveRow(rawRow, dateKey) {
    const row = { ...(rawRow || {}) };
    if (state.r2CountPresence.observations.has(dateKey)) {
      row.r2_observs = true;
      row.r2 = true;
    }
    if (state.r2CountPresence.aqilevels.has(dateKey)) {
      row.r2_aqilevels = true;
    }
    return row;
  }

  function hasObsAqiObservs(row) {
    return row && row.obs_aqi_observs !== undefined
      ? Boolean(row.obs_aqi_observs)
      : Boolean(row && row.observs);
  }

  function hasR2Observs(row) {
    return Boolean(row && (row.r2_observs || row.r2 || row.dropbox_observs));
  }

  function hasR2Aqilevels(row) {
    return Boolean(row && (row.r2_aqilevels || row.dropbox_aqilevels));
  }

  function buildLayers(row) {
    const layers = [];

    if (row && row.ingest) {
      layers.push({
        key: "ingest",
        label: "IngestDB",
        className: "coverage-bar-ingest",
        backup: false,
        backupOnly: false,
      });
    }

    if (hasObsAqiObservs(row)) {
      layers.push({
        key: "obsaqi-observs",
        label: "ObsAQIDB - Obs",
        className: "coverage-bar-obsaqi-observs",
        backup: false,
        backupOnly: false,
      });
    }

    if (hasR2Observs(row)) {
      const r2Present = Boolean(row && (row.r2_observs || row.r2));
      const backup = Boolean(row && row.dropbox_observs);
      layers.push({
        key: "r2-observs",
        label: r2Present ? "R2 History - Obs" : "Backup - Obs",
        className: r2Present
          ? "coverage-bar-r2-observs"
          : "coverage-bar-dropbox-only-observs",
        backup,
        backupOnly: !r2Present && backup,
      });
    }

    if (hasR2Aqilevels(row)) {
      const r2Present = Boolean(row && row.r2_aqilevels);
      const backup = Boolean(row && row.dropbox_aqilevels);
      layers.push({
        key: "r2-aqilevels",
        label: r2Present ? "R2 History - AQI" : "Backup - AQI",
        className: r2Present
          ? "coverage-bar-r2-aqilevels"
          : "coverage-bar-dropbox-only-aqilevels",
        backup,
        backupOnly: !r2Present && backup,
      });
    }

    return layers;
  }

  function backupIconMarkup(className = "coverage-bar-label-secondary-icon is-dropbox-blue") {
    return `<img class="${className}" src="${DROPBOX_ICON_PATH}" alt="" aria-hidden="true">`;
  }

  function layerTitle(layer) {
    return layer.backup ? `${layer.label} • Dropbox backup` : layer.label;
  }

  function renderFullBar(layer) {
    const title = layerTitle(layer);
    let labelMarkup = `<span class="coverage-bar-label-primary">${layer.label}</span>`;

    if (layer.backupOnly) {
      labelMarkup = `
        <span class="coverage-bar-label-primary with-icon">
          ${backupIconMarkup("coverage-bar-label-primary-icon is-dropbox-blue")}
          <span class="coverage-bar-label-primary-text">${layer.label}</span>
        </span>
      `;
    } else if (layer.backup) {
      labelMarkup += `
        <span class="coverage-bar-label-secondary is-dropbox-badge">
          ${backupIconMarkup()}
          Backup
        </span>
      `;
    }

    return `
      <span class="coverage-bar ${layer.className}" title="${title}">
        <span class="coverage-bar-label${layer.backup && !layer.backupOnly ? " has-secondary" : ""}">
          ${labelMarkup}
        </span>
      </span>
    `;
  }

  function renderCompactBar(layer, className = "") {
    const title = layerTitle(layer);
    const icon = layer.backup
      ? backupIconMarkup("ukaq-today-dropbox-icon")
      : "";
    return `
      <span class="coverage-bar ${layer.className} ${className}" title="${title}" aria-label="${title}">
        ${icon}
      </span>
    `;
  }

  function renderSplitBar(layer) {
    const title = layerTitle(layer);
    const icon = layer.backup
      ? backupIconMarkup("ukaq-split-dropbox-icon")
      : "";
    return `
      <span class="coverage-bar ${layer.className}" title="${title}" aria-label="${title}">
        ${icon}
      </span>
    `;
  }

  function sourceSummary(row) {
    const summary = [];
    if (row && row.ingest) summary.push("IngestDB");
    if (hasObsAqiObservs(row)) summary.push("ObsAQIDB - Obs");
    if (hasR2Observs(row)) {
      summary.push(row && (row.r2_observs || row.r2)
        ? "R2 History - Obs"
        : "Backup - Obs");
    }
    if (hasR2Aqilevels(row)) {
      summary.push(row && row.r2_aqilevels
        ? "R2 History - AQI"
        : "Backup - AQI");
    }
    return summary;
  }

  function renderMonthCell(cell, row, dateKey) {
    const bars = cell.querySelector(".coverage-bars");
    if (!bars) return;

    const slots = Array.from(
      bars.querySelectorAll(":scope > .coverage-bar-slot"),
    ).slice(0, 3);
    if (slots.length !== 3) return;

    slots.forEach((slot) => {
      slot.classList.remove("ukaq-dual-storage");
      slot.classList.add("ukaq-storage-slot");
      slot.replaceChildren();
    });

    const layers = buildLayers(row);
    const isToday = Boolean(row && row.isToday) || dateKey === todayUtcKey();

    if (isToday) {
      if (layers.length === 4) {
        slots[0].innerHTML = renderCompactBar(layers[0], "ukaq-today-bar");
        slots[1].innerHTML = renderCompactBar(layers[1], "ukaq-today-bar");
        slots[2].innerHTML = `
          <span class="ukaq-storage-row-split ukaq-today-split">
            ${renderSplitBar(layers[2])}
            ${renderSplitBar(layers[3])}
          </span>
        `;
      } else {
        layers.slice(0, 3).forEach((layer, index) => {
          slots[index].innerHTML = renderCompactBar(layer, "ukaq-today-bar");
        });
      }
    } else if (layers.length === 4) {
      slots[0].innerHTML = renderFullBar(layers[0]);
      slots[1].innerHTML = renderFullBar(layers[1]);
      slots[2].innerHTML = `
        <span class="ukaq-storage-row-split">
          ${renderSplitBar(layers[2])}
          ${renderSplitBar(layers[3])}
        </span>
      `;
    } else {
      layers.slice(0, 3).forEach((layer, index) => {
        slots[index].innerHTML = renderFullBar(layer);
      });
    }

    const sources = sourceSummary(row);
    cell.title = sources.length
      ? `${dateKey} • Sources: ${sources.join(", ")}`
      : `${dateKey} • No data in storage layers`;
  }

  function renderYearCell(cell, row, dateKey) {
    const grid = cell.querySelector(".coverage-square-grid");
    if (!grid) return;

    if ((row && row.isToday) || dateKey === todayUtcKey()) {
      return;
    }

    const layers = buildLayers(row);
    const slots = Array.from({ length: 4 }, (_, index) => layers[index] || null);

    grid.innerHTML = slots.map((layer) => {
      if (!layer) {
        return '<span class="coverage-square is-empty"></span>';
      }
      const title = layerTitle(layer);
      const icon = layer.backup
        ? backupIconMarkup("ukaq-year-dropbox-icon")
        : "";
      return `
        <span class="coverage-square ${layer.className}" title="${title}" aria-label="${title}">
          ${icon}
        </span>
      `;
    }).join("");

    const sources = sourceSummary(row);
    cell.title = sources.length
      ? `${dateKey} • Sources: ${sources.join(", ")}`
      : `${dateKey} • No data in storage layers`;
  }

  function appendCoverageDiagnostics(panel, payload) {
    panel.querySelectorAll(".ukaq-coverage-meta").forEach((node) => node.remove());

    const meta = document.createElement("div");
    meta.className = "footnote ukaq-coverage-meta";

    const generatedAt = payload.storage_coverage_generated_at;
    const nextRefreshAt = payload.storage_coverage_next_refresh_at;
    const ttlSeconds = Number(payload.storage_coverage_cache_ttl_seconds || 0);
    const ttlHours = ttlSeconds > 0 ? ttlSeconds / 3600 : null;

    const details = [];
    if (generatedAt) details.push(`Coverage generated ${utcLabel(generatedAt)}`);
    if (nextRefreshAt) details.push(`next automatic refresh ${utcLabel(nextRefreshAt)}`);
    if (ttlHours !== null) {
      details.push(`cache ${Number.isInteger(ttlHours) ? ttlHours : ttlHours.toFixed(1)} hours`);
    }
    details.push("Force Refresh checks current storage now");
    meta.textContent = details.join(" · ");
    panel.appendChild(meta);

    const warning = String(payload.ingest_coverage_warning || "").trim();
    if (warning) {
      const warningEl = document.createElement("div");
      warningEl.className = "footnote ukaq-coverage-meta ukaq-coverage-warning";
      warningEl.textContent = warning;
      panel.appendChild(warningEl);
    }
  }

  function updateFootnote(panel) {
    const footnotes = Array.from(panel.querySelectorAll(":scope > .footnote"))
      .filter((node) => !node.classList.contains("ukaq-coverage-meta"));
    const primaryFootnote = footnotes[0];
    if (!primaryFootnote) return;

    primaryFootnote.textContent =
      "Rows: IngestDB (red), ObsAQIDB - Obs (blue), R2 History - Obs (orange), "
      + "then R2 History - AQI (yellow). When all four are present, the orange "
      + "and yellow R2 layers share the third row. A blue Dropbox icon marks a "
      + "Dropbox copy of the corresponding R2 layer. Today uses half-width bars "
      + "without text.";
  }

  function enhanceCoveragePanel() {
    const payload = state.coveragePayload;
    if (!payload) return;

    injectStyles();
    const rowsByDate = rowMap(payload);
    const panels = document.querySelectorAll(".coverage-calendar-panel");

    panels.forEach((panel) => {
      if (panel.dataset.ukaqCoverageRevision === String(state.revision)) return;

      panel.querySelectorAll(".coverage-day-cell, .coverage-year-day").forEach((cell) => {
        const dateKey = cellDateKey(cell);
        if (!dateKey) return;

        const rawRow = rowsByDate.get(dateKey) || { date: dateKey };
        const row = effectiveRow(rawRow, dateKey);

        if (cell.classList.contains("coverage-year-day")) {
          renderYearCell(cell, row, dateKey);
        } else {
          renderMonthCell(cell, row, dateKey);
        }
      });

      updateFootnote(panel);
      appendCoverageDiagnostics(panel, payload);
      panel.dataset.ukaqCoverageRevision = String(state.revision);
    });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = requestUrl(args[0]);
    const response = await originalFetch(...args);

    if (isStorageCoverageRequest(url)) {
      response.clone().json().then((payload) => {
        if (!payload || typeof payload !== "object") return;
        state.coveragePayload = payload;
        state.revision += 1;
        scheduleEnhancement();
      }).catch(() => {
        // The dashboard's normal error handling remains authoritative.
      });
    }

    if (isR2ConnectorCountsRequest(url)) {
      response.clone().json().then((payload) => {
        if (!payload || typeof payload !== "object") return;
        updateR2CountPresence(payload, url);
        state.revision += 1;
        scheduleEnhancement();
      }).catch(() => {
        // The dashboard's normal error handling remains authoritative.
      });
    }

    return response;
  };

  const observer = new MutationObserver(() => scheduleEnhancement());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
