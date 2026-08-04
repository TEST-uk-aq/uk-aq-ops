window.UKAQ_OPS_CONFIG = {
  "envName": "CIC-Test",
  "apiBaseUrl": "/api",
  "dashboardTitle": "UK AQ Dashboard - TEST",
  "dashboardSubtitle": "Live snapshot of PM2.5, PM10, and NO2 freshness using timeseries last_value_at. Data updates from your local API.",
  "defaultRefreshSeconds": 300
};

(() => {
  const state = {
    payload: null,
    revision: 0,
    scheduled: false,
  };

  function isStorageCoverageRequest(input) {
    const rawUrl = typeof input === "string"
      ? input
      : input && typeof input.url === "string"
        ? input.url
        : "";
    return rawUrl.includes("storage_coverage");
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
      .coverage-bar-slot.ukaq-dual-storage {
        gap: 4px;
      }

      .coverage-bar-slot.ukaq-dual-storage > .coverage-bar {
        width: auto;
        min-width: 0;
      }

      .coverage-bar-slot.ukaq-dual-storage > .coverage-bar-r2-observs {
        flex: 2 1 0;
      }

      .coverage-bar-slot.ukaq-dual-storage > .ukaq-dual-ingest-bar {
        flex: 1 1 0;
      }

      .ukaq-dual-ingest-bar .coverage-bar-label-primary {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

  function rowMap(payload) {
    const rows = payload && Array.isArray(payload.storage_coverage_days)
      ? payload.storage_coverage_days
      : [];
    return new Map(
      rows
        .filter((row) => row && typeof row.date === "string")
        .map((row) => [row.date, row]),
    );
  }

  function cellDateKey(cell) {
    const title = String(cell.getAttribute("title") || "");
    const match = title.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }

  function addMonthDualStorageMarker(cell) {
    const topSlot = cell.querySelector(".coverage-bar-slot");
    if (!topSlot || topSlot.querySelector(".ukaq-dual-ingest-bar")) return;

    const ingestBar = document.createElement("span");
    ingestBar.className = "coverage-bar coverage-bar-ingest ukaq-dual-ingest-bar";
    ingestBar.title = "Ingest DB (also present)";
    ingestBar.setAttribute("aria-label", "Ingest DB also present");
    ingestBar.innerHTML = `
      <span class="coverage-bar-label">
        <span class="coverage-bar-label-primary">Ingest</span>
      </span>
    `;

    topSlot.classList.add("ukaq-dual-storage");
    topSlot.insertBefore(ingestBar, topSlot.firstChild);
  }

  function addYearDualStorageMarker(cell) {
    const squareGrid = cell.querySelector(".coverage-square-grid");
    if (!squareGrid || squareGrid.querySelector(".ukaq-dual-ingest-square")) return;

    const square = document.createElement("span");
    square.className = "coverage-square coverage-bar-ingest ukaq-dual-ingest-square";
    square.title = "Ingest DB (also present)";
    square.setAttribute("aria-label", "Ingest DB also present");
    squareGrid.insertBefore(square, squareGrid.firstChild);
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
    if (!primaryFootnote || primaryFootnote.dataset.ukaqDualStorageUpdated === "1") return;

    primaryFootnote.textContent = primaryFootnote.textContent.replace(
      "Top: Ingest DB (red), R2 History - Obs (orange), or Backup - Obs (orange filled).",
      "Top: Ingest DB (red), R2 History - Obs (orange), or both shown side by side; Backup - Obs is orange filled.",
    );
    primaryFootnote.dataset.ukaqDualStorageUpdated = "1";
  }

  function enhanceCoveragePanel() {
    const payload = state.payload;
    if (!payload) return;

    injectStyles();
    const rowsByDate = rowMap(payload);
    const panels = document.querySelectorAll(".coverage-calendar-panel");

    panels.forEach((panel) => {
      if (panel.dataset.ukaqCoverageRevision === String(state.revision)) return;

      panel.querySelectorAll(".coverage-day-cell, .coverage-year-day").forEach((cell) => {
        const dateKey = cellDateKey(cell);
        const row = rowsByDate.get(dateKey);
        if (!row || !row.ingest || !row.r2_observs) return;

        if (cell.classList.contains("coverage-year-day")) {
          addYearDualStorageMarker(cell);
        } else {
          addMonthDualStorageMarker(cell);
        }
      });

      updateFootnote(panel);
      appendCoverageDiagnostics(panel, payload);
      panel.dataset.ukaqCoverageRevision = String(state.revision);
    });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (isStorageCoverageRequest(args[0])) {
      response.clone().json().then((payload) => {
        if (!payload || typeof payload !== "object") return;
        state.payload = payload;
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

