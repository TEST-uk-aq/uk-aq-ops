(() => {
  const STYLE_ID = "ukaq-storage-coverage-backup-only-styles";
  const FOOTNOTE_TEXT =
    "Rows: IngestDB (red), ObsAQIDB - Obs (blue), R2 History - Obs (orange), "
    + "then R2 History - AQI (yellow). When all four are present, the orange "
    + "and yellow R2 layers share the third row. A blue Dropbox icon marks a "
    + "Dropbox copy when the matching R2 layer also exists. A Dropbox-only "
    + "observation or AQI backup is white with an orange or yellow border. "
    + "Today uses half-width bars without text.";

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .coverage-bar-dropbox-only-observs {
        background: #fff !important;
        border: 2px solid var(--color-r2-observs) !important;
      }

      .coverage-bar-dropbox-only-aqilevels {
        background: #fff !important;
        border: 2px solid var(--color-r2-aqilevels) !important;
      }

      .coverage-bar-dropbox-only-observs,
      .coverage-bar-dropbox-only-observs .coverage-bar-label,
      .coverage-bar-dropbox-only-observs .coverage-bar-label-primary,
      .coverage-bar-dropbox-only-observs .coverage-bar-label-primary-text,
      .coverage-bar-dropbox-only-aqilevels,
      .coverage-bar-dropbox-only-aqilevels .coverage-bar-label,
      .coverage-bar-dropbox-only-aqilevels .coverage-bar-label-primary,
      .coverage-bar-dropbox-only-aqilevels .coverage-bar-label-primary-text {
        color: #111 !important;
      }

      .coverage-square.coverage-bar-dropbox-only-observs,
      .coverage-square.coverage-bar-dropbox-only-aqilevels {
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  }

  function updateFootnotes() {
    document.querySelectorAll(".coverage-calendar-panel").forEach((panel) => {
      const footnote = Array.from(panel.querySelectorAll(":scope > .footnote"))
        .find((node) => !node.classList.contains("ukaq-coverage-meta"));
      if (footnote && footnote.textContent !== FOOTNOTE_TEXT) {
        footnote.textContent = FOOTNOTE_TEXT;
      }
    });
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      injectStyles();
      updateFootnotes();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  schedule();
})();
