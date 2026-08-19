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
  `;
  document.head.appendChild(style);
})();
