(() => {
  "use strict";

  const TABS = ["articles", "runs", "sources"];
  const TAB_LABELS = { articles: "Articles", runs: "Runs", sources: "Sources" };
  const SORTS = [
    ["published_desc", "Published Date: Newest to Oldest"],
    ["published_asc", "Published Date: Oldest to Newest"],
    ["approved_desc", "Approved Date: Newest to Oldest"],
    ["approved_asc", "Approved Date: Oldest to Newest"],
    ["discovered_desc", "Discovered Date: Newest to Oldest"],
    ["updated_desc", "Recently Updated"],
  ];
  const STATUS_LABELS = { approved: "Approved", pending: "Pending", rejected: "Rejected", hidden: "Hidden" };
  const STATUS_ACTIONS = {
    pending: [["approved", "Approve", "approve"], ["rejected", "Reject", "reject"], ["hidden", "Hide", "hide"]],
    approved: [["hidden", "Hide", "hide"], ["rejected", "Reject", "reject"]],
    rejected: [["approved", "Approve", "approve"], ["hidden", "Hide", "hide"]],
    hidden: [["approved", "Approve", "unhide"], ["rejected", "Reject", "reject"]],
  };
  const AI_PREVIEW_MODES = ["desktop", "carousel", "mobile"];
  const MAX_BATCH_SELECTION = 50;
  const articleDetailCache = new Map();
  let articleRefreshSequence = 0;

  function storedAiPreviewMode() {
    try {
      const mode = sessionStorage.getItem("media-ai-preview-mode");
      return AI_PREVIEW_MODES.includes(mode) ? mode : "desktop";
    } catch (_error) { return "desktop"; }
  }

  const state = {
    root: null,
    apiBase: "/api",
    tab: "articles",
    loaded: new Set(),
    selectors: { publications: [], authors: [] },
    articles: [],
    articleCursor: null,
    articleHasMore: false,
    filters: { status: new Set(["approved"]), source: new Set(), author: new Set(), hasImage: "", titleState: new Set(), q: "", sort: "published_desc" },
    aiPreviewMode: storedAiPreviewMode(),
    selectedArticleIds: new Set(),
    expandedArticleIds: new Set(),
    aiUsage: null,
    batchMessage: "",
    runsCursor: null,
  };

  function esc(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(date).replace(",", "");
  }

  function formatPublishedDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric",
      timeZone: "Europe/London" }).format(date);
  }

  function duration(start, finish) {
    const startMs = Date.parse(start || "");
    const finishMs = Date.parse(finish || "");
    if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return "—";
    const seconds = Math.round((finishMs - startMs) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function idempotencyKey(prefix = "media") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
  }

  function apiUrl(path, params) {
    const url = `${state.apiBase}/media/${String(path).replace(/^\/+/, "")}`;
    const query = params instanceof URLSearchParams ? params.toString() : "";
    return query ? `${url}?${query}` : url;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotent) headers.set("Idempotency-Key", idempotencyKey(options.idempotent));
    let response;
    try {
      response = await fetch(apiUrl(path, options.params), { method: options.method || "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    } catch (_error) {
      throw new Error("Media admin unavailable.");
    }
    const contentType = String(response.headers.get("Content-Type") || "");
    const payload = contentType.includes("json") ? await response.json().catch(() => null) : null;
    if (!response.ok) {
      throw new Error(String(payload?.error?.message || payload?.error || payload?.message || `Media request failed (${response.status})`));
    }
    return payload;
  }

  function message(text, kind = "") {
    return `<div class="media-message${kind ? ` media-message--${kind}` : ""}" role="status">${esc(text)}</div>`;
  }

  function setView(html) {
    const view = state.root?.querySelector("[data-media-view]");
    if (view) view.innerHTML = html;
  }

  function setTab(tab) {
    if (!TABS.includes(tab)) return;
    state.tab = tab;
    state.root.querySelectorAll("[data-media-tab]").forEach(button => {
      const active = button.dataset.mediaTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (tab === "articles") void renderArticles(false);
    if (tab === "runs") void renderRuns(false);
    if (tab === "sources") void renderSources(false);
  }

  function checkedFilter(group, value) {
    return state.filters[group].has(value) ? " checked" : "";
  }

  function articleParams(cursor = null) {
    const params = new URLSearchParams({ limit: "20", sort: state.filters.sort });
    state.filters.status.forEach(value => params.append("status", value));
    state.filters.source.forEach(value => params.append("source", value));
    state.filters.author.forEach(value => params.append("author", value));
    state.filters.titleState.forEach(value => params.append("title_state", value));
    if (state.filters.hasImage) params.set("has_image", state.filters.hasImage);
    if (state.filters.q) params.set("q", state.filters.q);
    if (cursor) params.set("cursor", cursor);
    return params;
  }

  async function ensureSelectors() {
    if (state.selectors.publications.length || state.selectors.authors.length) return;
    const data = await request("articles/selectors");
    state.selectors = { publications: data.publications || [], authors: data.authors || [] };
  }

  function filterPanel() {
    const status = ["approved", "pending", "rejected", "hidden"].map(value =>
      `<label><input type="checkbox" data-filter="status" value="${value}"${checkedFilter("status", value)}> ${STATUS_LABELS[value]}</label>`).join("");
    const publications = state.selectors.publications.map(source =>
      `<label><input type="checkbox" data-filter="source" value="${esc(source.source_key)}"${checkedFilter("source", source.source_key)}> ${esc(source.name)}</label>`).join("");
    const authors = state.selectors.authors.map(author =>
      `<label data-author-option="${esc(String(author).toLowerCase())}"><input type="checkbox" data-filter="author" value="${esc(author)}"${checkedFilter("author", author)}> ${esc(author)}</label>`).join("");
    const titleStates = [["original", "Original"], ["publisher", "Publisher"], ["human", "Human"], ["ai", "AI Accepted"], ["pending_ai", "AI Pending"], ["rejected_ai", "AI Rejected"]]
      .map(([value, label]) => `<label><input type="checkbox" data-filter="titleState" value="${value}"${checkedFilter("titleState", value)}> ${label}</label>`).join("");
    return `<div class="media-filter-panel" aria-label="Article filters">
      <fieldset class="media-filter-group"><legend>Has image</legend><div class="media-filter-options">
        <label><input type="radio" name="media-has-image" data-filter-radio="hasImage" value=""${!state.filters.hasImage ? " checked" : ""}> Any</label>
        <label><input type="radio" name="media-has-image" data-filter-radio="hasImage" value="yes"${state.filters.hasImage === "yes" ? " checked" : ""}> Yes</label>
        <label><input type="radio" name="media-has-image" data-filter-radio="hasImage" value="no"${state.filters.hasImage === "no" ? " checked" : ""}> No</label>
      </div></fieldset>
      <fieldset class="media-filter-group"><legend>Title Status</legend><div class="media-filter-options">${titleStates}</div></fieldset>
      <fieldset class="media-filter-group media-filter-group--publication"><legend>Publication</legend>${filterScroll("publications", publications || "No publications")}</fieldset>
      <fieldset class="media-filter-group"><legend>Author</legend><label class="media-field"><input data-author-search type="search" placeholder="Find author"></label>${filterScroll("authors", authors || "No authors")}</fieldset>
      <fieldset class="media-filter-group"><legend>Article Status</legend><div class="media-filter-options">${status}</div></fieldset>
    </div><div class="media-active-filters" data-active-filters>${esc(activeFilterSummary())}</div>`;
  }

  function filterScroll(name, options) {
    const label = name === "publications" ? "publications" : "authors";
    return `<div class="media-filter-scroll" data-filter-scroll>
      <div class="media-filter-scroll__fade media-filter-scroll__fade--top" data-scroll-fade="up" aria-hidden="true" hidden></div>
      <button type="button" class="media-filter-scroll__indicator media-filter-scroll__indicator--top" data-scroll-direction="up" aria-label="Scroll ${label} up" hidden><span aria-hidden="true">▲</span></button>
      <div class="media-filter-options media-filter-scroll__viewport" data-filter-scroll-viewport tabindex="0">${options}</div>
      <div class="media-filter-scroll__fade media-filter-scroll__fade--bottom" data-scroll-fade="down" aria-hidden="true" hidden></div>
      <button type="button" class="media-filter-scroll__indicator media-filter-scroll__indicator--bottom" data-scroll-direction="down" aria-label="Scroll ${label} down" hidden><span aria-hidden="true">▼</span></button>
    </div>`;
  }

  function updateFilterScroll(scroll) {
    const viewport = scroll.querySelector("[data-filter-scroll-viewport]");
    if (!viewport) return;
    const tolerance = 2;
    const canScroll = viewport.scrollHeight > viewport.clientHeight + tolerance;
    const top = scroll.querySelector('[data-scroll-direction="up"]');
    const bottom = scroll.querySelector('[data-scroll-direction="down"]');
    const topHidden = !canScroll || viewport.scrollTop <= tolerance;
    const bottomHidden = !canScroll || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - tolerance;
    if (top) top.hidden = topHidden;
    if (bottom) bottom.hidden = bottomHidden;
    const topFade = scroll.querySelector('[data-scroll-fade="up"]');
    const bottomFade = scroll.querySelector('[data-scroll-fade="down"]');
    if (topFade) topFade.hidden = topHidden;
    if (bottomFade) bottomFade.hidden = bottomHidden;
  }

  function updateFilterScrolls() {
    state.root.querySelectorAll("[data-filter-scroll]").forEach(updateFilterScroll);
  }

  function bindFilterScrolls() {
    state.root.querySelectorAll("[data-filter-scroll]").forEach(scroll => {
      const viewport = scroll.querySelector("[data-filter-scroll-viewport]");
      if (!viewport) return;
      viewport.addEventListener("scroll", () => updateFilterScroll(scroll), { passive: true });
      scroll.querySelectorAll("[data-scroll-direction]").forEach(button => button.addEventListener("click", () => {
        viewport.scrollBy({ top: (button.dataset.scrollDirection === "up" ? -1 : 1) * viewport.clientHeight, behavior: "smooth" });
      }));
      updateFilterScroll(scroll);
    });
    requestAnimationFrame(updateFilterScrolls);
  }

  function activeFilterSummary() {
    const parts = [];
    if (state.filters.status.size) parts.push(`Article Status: ${[...state.filters.status].map(v => STATUS_LABELS[v]).join(", ")}`);
    if (state.filters.source.size) parts.push(`${state.filters.source.size} publication filter${state.filters.source.size === 1 ? "" : "s"}`);
    if (state.filters.author.size) parts.push(`${state.filters.author.size} author filter${state.filters.author.size === 1 ? "" : "s"}`);
    if (state.filters.hasImage) parts.push(`Image: ${state.filters.hasImage}`);
    if (state.filters.titleState.size) parts.push(`${state.filters.titleState.size} Title Status filter${state.filters.titleState.size === 1 ? "" : "s"}`);
    if (state.filters.q) parts.push(`Search: “${state.filters.q}”`);
    return parts.length ? `Active filters · ${parts.join(" · ")}` : "No active filters";
  }

  function statusOptions(status) {
    return [`<option value="${status}">${STATUS_LABELS[status]}</option>`]
      .concat((STATUS_ACTIONS[status] || []).map(([target, label, action]) =>
        `<option value="${target}" data-action="${action}">${label}</option>`)).join("");
  }

  function statusControl(article) {
    return `<div class="media-status-control" data-status-control data-id="${article.id}" data-current="${article.status}">
      <select aria-label="Article Status for ${esc(article.title)}">${statusOptions(article.status)}</select>
      <span class="media-save-state" title="Saved/current" aria-label="Saved/current">💾</span>
    </div>`;
  }

  function titleStatus(article) {
    if (article.display_title_origin === "human" && article.display_title) return ["human", "Human"];
    if (article.display_title_origin === "ai" && article.display_title) return ["ai", "AI Accepted"];
    if (article.ai_title_suggestion_state === "pending") return ["pending_ai", "AI Pending"];
    if (article.ai_title_suggestion_state === "rejected") return ["rejected_ai", "AI Rejected"];
    if (article.display_title_origin === "publisher" && article.display_title) return ["publisher", "Publisher"];
    return ["original", "Original"];
  }

  function hasAiTitleInformation(article) {
    return Boolean(article.ai_title_suggestion || article.ai_title_suggestion_state || article.ai_title_generated_at);
  }

  function aiPreviewControls() {
    return `<div class="media-ai-preview-controls"><span class="media-ai-preview-controls__label" id="media-ai-preview-label">Preview</span><div class="media-mini-nav" role="group" aria-labelledby="media-ai-preview-label">${AI_PREVIEW_MODES.map(value => `<button type="button" data-ai-preview-mode="${value}" class="${state.aiPreviewMode === value ? "is-active" : ""}" aria-pressed="${state.aiPreviewMode === value}">${value[0].toUpperCase() + value.slice(1)}</button>`).join("")}</div><span class="media-ai-carousel-note" title="Compact preview based on the current website card style; the public site does not yet have a separate carousel layout.">Carousel is a provisional compact card.</span></div>`;
  }

  function aiUsageHtml() {
    const day = state.aiUsage?.usage_days?.[0] || {};
    const entries = [[day.calculated_neurons_used, "Calculated neurons used today"], [day.media_daily_neuron_budget, "Media daily neuron budget"], [day.media_budget_remaining, "Media budget remaining"], [day.configured_cloudflare_free_allocation_neurons, "Configured Cloudflare free allowance"], [day.estimated_cloudflare_free_neurons_remaining, "Estimated Cloudflare allowance remaining"], [day.ai_requests, "Request count"], [day.ai_titles_attempted, "Titles attempted"], [day.titles_generated_successfully, "Titles generated"], [day.prompt_tokens, "Input tokens"], [day.completion_tokens, "Output tokens"], [day.outstanding_reserved_neurons, "Outstanding reserved neurons"]];
    return `<details class="media-ai-usage"><summary>AI Usage</summary><p>Media’s local budget is enforced here; Cloudflare allowance values are estimates, not billing authority.</p><div class="media-stats">${entries.map(([value, label]) => `<div class="media-stat"><strong>${esc(value ?? 0)}</strong><span>${esc(label)}</span></div>`).join("")}</div></details>`;
  }

  function inlineAiReview(article) {
    const pendingActions = article.ai_title_suggestion_state === "pending"
      ? `<button class="media-button media-button--primary" data-ai-action="accept-ai">Accept AI title</button><button class="media-button" data-ai-action="reject-ai">Reject AI / use original</button>` : "";
    const published = formatPublishedDate(article.published_at);
    const sourceRow = `${esc(article.publisher)}<span data-ai-preview-date>${published ? ` · ${esc(published)}` : ""}</span>`;
    return `<section class="media-review media-ai-preview-mode--${state.aiPreviewMode}" data-ai-id="${article.id}" data-ai-published="${published ? "true" : "false"}"><div class="media-review__layout"><div class="media-site-preview-wrap"><div class="media-site-preview" aria-label="Website article card preview"><img class="media-site-preview__image" loading="lazy" src="${esc(apiUrl(`articles/${article.id}/image`))}" alt="" data-ai-preview-image><div class="media-site-preview__gradient" aria-hidden="true"></div><div class="media-site-preview__overlay"><div class="media-site-preview__source-row">${sourceRow}</div><div class="media-site-preview__title" data-ai-preview-title>${esc(article.display_title || article.ai_title_suggestion || article.title)}</div></div></div></div><div class="media-review__controls"><span class="media-subtext">Generated ${esc(formatDate(article.ai_title_generated_at))} · AI suggestion ${esc(article.ai_title_suggestion_state || "none")}</span><div class="media-review__titles"><div class="media-review__title"><span>Publisher original</span>${esc(article.title)}</div><div class="media-review__title"><span>AI suggestion</span>${esc(article.ai_title_suggestion || "—")}</div><div class="media-review__title"><span>Current display title</span>${esc(article.display_title || "Publisher original")} · ${esc(titleStatus(article)[1])}</div></div><div class="media-actions">${pendingActions}<label class="media-field media-field--grow"><span>Edit as human title</span><input data-ai-edit value="${esc(article.display_title || article.ai_title_suggestion || "")}" data-ai-suggestion="${esc(article.ai_title_suggestion || article.title)}" maxlength="500"></label><button class="media-button" data-ai-action="edit">Save human title</button>${article.display_title ? `<button class="media-button" data-ai-action="clear">Clear display title</button>` : ""}</div><div data-ai-message></div></div></div></section>`;
  }

  function articleRow(article) {
    const title = article.display_title || article.title;
    const [titleState, titleLabel] = titleStatus(article);
    const isExpanded = state.expandedArticleIds.has(String(article.id));
    const thumb = article.admin_preview_image_path
      ? `<img class="media-thumb" loading="lazy" src="${esc(apiUrl(`articles/${article.id}/image`))}" alt="" data-media-thumb>`
      : `<span class="media-thumb-fallback">No image</span>`;
    return `<tr data-article-id="${article.id}"><td class="media-select-cell"><input type="checkbox" data-select-article aria-label="Select ${esc(title)}"${state.selectedArticleIds.has(String(article.id)) ? " checked" : ""}></td><td>${thumb}</td>
      <td class="media-title-cell"><button type="button" class="media-title-button" data-open-article>${esc(title)}</button>${article.display_title ? `<span class="media-subtext">Original: ${esc(article.title)}</span>` : ""}</td>
      <td>${esc(article.publisher)}</td><td>${esc(article.author || "—")}</td>
      <td>${esc(formatDate(article.published_at))}</td><td>${esc(formatDate(article.approved_at))}</td>
      <td><span class="media-title-status media-title-status--${esc(titleState)}">${esc(titleLabel)}</span>${hasAiTitleInformation(article) ? `<button type="button" class="media-ai-disclosure" data-toggle-ai aria-expanded="${isExpanded}">${isExpanded ? "▴ Hide" : "▾ Review AI"}</button>` : ""}</td><td>${statusControl(article)}</td></tr>${isExpanded ? `<tr class="media-ai-expanded"><td colspan="9">${inlineAiReview(article)}</td></tr>` : ""}`;
  }

  function bulkToolbarHtml() {
    const count = state.selectedArticleIds.size;
    return `<div class="media-bulk-toolbar"><strong>${count} selected</strong><label class="media-field"><span>Change Article Status to</span><select data-bulk-status ${count ? "" : "disabled"}><option value="">Choose status…</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="hidden">Hidden</option></select></label><button type="button" class="media-button media-button--primary" data-save-bulk ${count ? "" : "disabled"}>Save</button><span class="media-subtext">Current loaded rows only · maximum ${MAX_BATCH_SELECTION}</span><div data-bulk-message>${state.batchMessage ? message(state.batchMessage.text, state.batchMessage.kind) : ""}</div></div>`;
  }

  function articleTableHtml(error = "") {
    const rows = state.articles.map(articleRow).join("");
    const selectedLoaded = state.articles.filter(article => state.selectedArticleIds.has(String(article.id))).length;
    const allSelected = state.articles.length > 0 && selectedLoaded === state.articles.length;
    return `${error ? message(error, "error") : ""}${bulkToolbarHtml()}<div class="media-table-wrap"><table class="media-table">
      <thead><tr><th class="media-select-cell"><input type="checkbox" data-select-all aria-label="Select all currently loaded articles"${allSelected ? " checked" : ""}></th><th>Image</th><th>Title</th><th>Publication</th><th>Author</th><th>Published</th><th>Approved</th><th>Title Status</th><th>Article Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="media-empty">No articles match these filters.</td></tr>`}</tbody>
    </table></div>${state.articleHasMore ? `<div class="media-actions"><button class="media-button" data-load-more-articles>Load more</button></div>` : ""}`;
  }

  async function renderArticles(append) {
    articleRefreshSequence += 1;
    if (!append) {
      setView(`<section class="media-card"><div class="media-loading">Loading Articles…</div></section>`);
    }
    try {
      await ensureSelectors();
      const cursor = append ? state.articleCursor : null;
      const [data, usage] = await Promise.all([request("articles", { params: articleParams(cursor) }), request("ai-usage", { params: new URLSearchParams({ limit: "1" }) }).catch(() => null)]);
      state.aiUsage = usage;
      state.articles = append ? state.articles.concat(data.articles || []) : (data.articles || []);
      state.articleCursor = data.page?.next_cursor || null;
      state.articleHasMore = Boolean(data.page?.has_more);
      setView(`<section class="media-card"><div class="media-toolbar"><div><h3>Articles</h3><p>Authoritative Media D1 editorial state.</p></div>${aiPreviewControls()}
        <button class="media-button media-button--primary" data-focus-add>+ Add Article</button></div>
        <form class="media-url-form" data-url-lookup><label class="media-field media-field--grow"><span>Search / Add article URL</span><input name="url" type="url" required placeholder="https://publisher.example/article"></label><button class="media-button media-button--primary">Search</button></form>
        <div data-url-result></div>${aiUsageHtml()}</section>
        <section class="media-card"><div class="media-toolbar"><form class="media-toolbar__group" data-table-search><label class="media-field"><span>Search existing rows</span><input name="q" type="search" value="${esc(state.filters.q)}" placeholder="Title, URL or author"></label><button class="media-button">Search</button><button type="button" class="media-button" data-clear-filters>Clear filters</button></form>
          <label class="media-field"><span>Sort</span><select data-article-sort>${SORTS.map(([value, label]) => `<option value="${value}"${state.filters.sort === value ? " selected" : ""}>${label}</option>`).join("")}</select></label></div>
          ${filterPanel()}<div data-article-table>${articleTableHtml()}</div></section>`);
      bindArticleEvents();
    } catch (error) {
      setView(`<section class="media-card"><h3>Articles</h3>${message(error.message || "Media admin unavailable.", "error")}</section>`);
    }
  }

  async function refreshArticleTable(append = false) {
    const table = state.root.querySelector("[data-article-table]");
    if (!table) return;
    const refreshSequence = ++articleRefreshSequence;
    const summary = state.root.querySelector("[data-active-filters]");
    if (summary) summary.textContent = activeFilterSummary();
    table.setAttribute("aria-busy", "true");
    const loadMore = table.querySelector("[data-load-more-articles]");
    if (loadMore) loadMore.disabled = true;
    try {
      const cursor = append ? state.articleCursor : null;
      const data = await request("articles", { params: articleParams(cursor) });
      if (refreshSequence !== articleRefreshSequence) return;
      state.articles = append ? state.articles.concat(data.articles || []) : (data.articles || []);
      const loadedIds = new Set(state.articles.map(article => String(article.id)));
      state.selectedArticleIds = new Set([...state.selectedArticleIds].filter(id => loadedIds.has(id)));
      state.articleCursor = data.page?.next_cursor || null;
      state.articleHasMore = Boolean(data.page?.has_more);
      table.innerHTML = articleTableHtml();
      bindArticleTableEvents();
    } catch (error) {
      if (refreshSequence !== articleRefreshSequence) return;
      table.innerHTML = articleTableHtml(error.message || "Media admin unavailable.");
      bindArticleTableEvents();
    } finally {
      if (refreshSequence === articleRefreshSequence) table.removeAttribute("aria-busy");
    }
  }

  function syncArticleFilterControls() {
    const search = state.root.querySelector("[data-table-search] input[name='q']");
    if (search) search.value = state.filters.q;
    const sort = state.root.querySelector("[data-article-sort]");
    if (sort) sort.value = state.filters.sort;
    state.root.querySelectorAll("[data-filter]").forEach(input => {
      input.checked = state.filters[input.dataset.filter].has(input.value);
    });
    state.root.querySelectorAll("[data-filter-radio]").forEach(input => {
      input.checked = state.filters[input.dataset.filterRadio] === input.value;
    });
    updateFilterScrolls();
  }

  function bindArticleEvents() {
    state.root.querySelector("[data-focus-add]")?.addEventListener("click", () => {
      const input = state.root.querySelector("[data-url-lookup] input"); input?.focus(); input?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    state.root.querySelector("[data-url-lookup]")?.addEventListener("submit", event => { event.preventDefault(); void lookupUrl(new FormData(event.currentTarget).get("url")); });
    state.root.querySelector("[data-table-search]")?.addEventListener("submit", event => { event.preventDefault(); state.filters.q = String(new FormData(event.currentTarget).get("q") || "").trim(); clearArticleSelection(); void refreshArticleTable(); });
    state.root.querySelector("[data-clear-filters]")?.addEventListener("click", () => {
      state.filters = { status: new Set(["approved"]), source: new Set(), author: new Set(), hasImage: "", titleState: new Set(), q: "", sort: "published_desc" };
      clearArticleSelection();
      syncArticleFilterControls();
      const authorSearch = state.root.querySelector("[data-author-search]");
      if (authorSearch) authorSearch.value = "";
      state.root.querySelectorAll("[data-author-option]").forEach(option => { option.hidden = false; });
      state.root.querySelectorAll("[data-filter-scroll-viewport]").forEach(viewport => { viewport.scrollTop = 0; });
      updateFilterScrolls();
      void refreshArticleTable();
    });
    state.root.querySelector("[data-article-sort]")?.addEventListener("change", event => { state.filters.sort = event.target.value; clearArticleSelection(); void refreshArticleTable(); });
    state.root.querySelectorAll("[data-filter]").forEach(input => input.addEventListener("change", event => {
      const set = state.filters[event.target.dataset.filter]; event.target.checked ? set.add(event.target.value) : set.delete(event.target.value); clearArticleSelection(); void refreshArticleTable();
    }));
    state.root.querySelectorAll("[data-filter-radio]").forEach(input => input.addEventListener("change", event => { state.filters[event.target.dataset.filterRadio] = event.target.value; clearArticleSelection(); void refreshArticleTable(); }));
    state.root.querySelector("[data-author-search]")?.addEventListener("input", event => {
      const query = event.target.value.toLowerCase(); state.root.querySelectorAll("[data-author-option]").forEach(option => { option.hidden = !option.dataset.authorOption.includes(query); });
      updateFilterScrolls();
    });
    bindFilterScrolls();
    bindArticleTableEvents();
  }

  function bindArticleTableEvents() {
    state.root.querySelector("[data-load-more-articles]")?.addEventListener("click", () => void refreshArticleTable(true));
    state.root.querySelectorAll("[data-ai-preview-mode]").forEach(button => button.addEventListener("click", () => setAiPreviewMode(button.dataset.aiPreviewMode)));
    state.root.querySelector("[data-select-all]")?.addEventListener("change", event => {
      const ids = state.articles.map(article => String(article.id));
      if (event.target.checked) ids.forEach(id => state.selectedArticleIds.add(id));
      else ids.forEach(id => state.selectedArticleIds.delete(id));
      refreshSelectionControls();
    });
    state.root.querySelectorAll("[data-select-article]").forEach(input => input.addEventListener("change", event => {
      const id = String(event.target.closest("[data-article-id]").dataset.articleId);
      if (event.target.checked) state.selectedArticleIds.add(id); else state.selectedArticleIds.delete(id);
      refreshSelectionControls();
    }));
    state.root.querySelector("[data-save-bulk]")?.addEventListener("click", () => void saveBulkStatus());
    state.root.querySelectorAll("[data-status-control] select").forEach(select => select.addEventListener("change", event => {
      const control = event.target.closest("[data-status-control]");
      const current = control.dataset.current;
      const saved = control.querySelector(".media-save-state");
      if (event.target.value === current) {
        saved.outerHTML = `<span class="media-save-state" title="Saved/current" aria-label="Saved/current">💾</span>`;
      } else {
        saved.outerHTML = `<button type="button" class="media-save-state is-unsaved" title="Save status change" aria-label="Save status change">💾</button>`;
        control.querySelector("button")?.addEventListener("click", () => void saveStatus(control));
      }
    }));
    state.root.querySelectorAll("[data-article-id]").forEach(row => row.addEventListener("click", event => {
      if (event.target.closest("button,select,input,a")) return;
      void openArticle(Number(row.dataset.articleId));
    }));
    state.root.querySelectorAll("[data-open-article]").forEach(button => button.addEventListener("click", () => {
      void openArticle(Number(button.closest("[data-article-id]").dataset.articleId));
    }));
    state.root.querySelectorAll("[data-toggle-ai]").forEach(button => button.addEventListener("click", () => {
      const id = String(button.closest("[data-article-id]").dataset.articleId);
      state.expandedArticleIds.has(id) ? state.expandedArticleIds.delete(id) : state.expandedArticleIds.add(id);
      const table = state.root.querySelector("[data-article-table]"); table.innerHTML = articleTableHtml(); bindArticleTableEvents(); hydrateAiPreviewDetails();
    }));
    state.root.querySelectorAll("[data-media-thumb]").forEach(image => image.addEventListener("error", () => { image.outerHTML = `<span class="media-thumb-fallback">Image unavailable</span>`; }, { once: true }));
    bindAiActions();
    hydrateAiPreviewDetails();
  }

  function clearArticleSelection() { state.selectedArticleIds.clear(); state.batchMessage = ""; }

  function refreshSelectionControls() {
    const table = state.root.querySelector("[data-article-table]");
    if (!table) return;
    const count = state.selectedArticleIds.size;
    const selectedLoaded = state.articles.filter(article => state.selectedArticleIds.has(String(article.id))).length;
    const all = table.querySelector("[data-select-all]");
    if (all) { all.checked = state.articles.length > 0 && selectedLoaded === state.articles.length; all.indeterminate = selectedLoaded > 0 && selectedLoaded < state.articles.length; }
    table.querySelectorAll("[data-select-article]").forEach(input => { input.checked = state.selectedArticleIds.has(String(input.closest("[data-article-id]").dataset.articleId)); });
    const label = table.querySelector(".media-bulk-toolbar strong"); if (label) label.textContent = `${count} selected`;
    const target = table.querySelector("[data-bulk-status]"); const save = table.querySelector("[data-save-bulk]");
    if (target) target.disabled = count === 0; if (save) save.disabled = count === 0 || count > MAX_BATCH_SELECTION || !target?.value;
    const output = table.querySelector("[data-bulk-message]"); if (output) output.innerHTML = state.batchMessage ? message(state.batchMessage.text, state.batchMessage.kind) : "";
    target?.addEventListener("change", () => { if (save) save.disabled = count === 0 || count > MAX_BATCH_SELECTION || !target.value; });
  }

  async function saveBulkStatus() {
    const table = state.root.querySelector("[data-article-table]"); const target = table?.querySelector("[data-bulk-status]")?.value;
    if (!target || !["approved", "rejected", "hidden"].includes(target)) return;
    const selected = state.articles.filter(article => state.selectedArticleIds.has(String(article.id)));
    if (selected.length > MAX_BATCH_SELECTION) { state.batchMessage = { text: `Apply Article Status to at most ${MAX_BATCH_SELECTION} selected rows at a time.`, kind: "error" }; refreshSelectionControls(); return; }
    const changes = selected.map(article => ({ article, action: (STATUS_ACTIONS[article.status] || []).find(([next]) => next === target)?.[2] })).filter(item => item.action);
    const save = table.querySelector("[data-save-bulk]"); save.disabled = true;
    const results = await Promise.allSettled(changes.map(({ article, action }) => request(`articles/${article.id}/${action}`, { method: "POST", idempotent: "status" })));
    const succeeded = results.filter(result => result.status === "fulfilled").length;
    const failed = results.length - succeeded;
    state.batchMessage = { text: `${succeeded} changed${selected.length - changes.length ? `; ${selected.length - changes.length} already ${STATUS_LABELS[target]}` : ""}${failed ? `; ${failed} failed` : ""}.`, kind: failed ? "error" : "success" };
    if (succeeded || selected.length !== changes.length) await refreshArticleTable(false);
    else refreshSelectionControls();
  }

  async function saveStatus(control) {
    const select = control.querySelector("select");
    const option = select.selectedOptions[0];
    const action = option.dataset.action;
    if (!action) return;
    const nextStatus = option.value;
    const button = control.querySelector("button"); button.disabled = true;
    try {
      await request(`articles/${control.dataset.id}/${action}`, { method: "POST", idempotent: "status" });
      await refreshArticleTable(false);
    } catch (error) {
      button.disabled = false;
      const prior = control.parentElement.querySelector(".media-message"); prior?.remove();
      control.parentElement.insertAdjacentHTML("beforeend", message(error.message, "error"));
    }
  }

  async function lookupUrl(value) {
    const result = state.root.querySelector("[data-url-result]");
    result.innerHTML = message("Checking canonical Media identity…");
    try {
      const data = await request("articles/lookup", { method: "POST", body: { url: String(value) } });
      if (data.article) {
        result.innerHTML = `${message(`Existing ${STATUS_LABELS[data.article.status] || data.article.status} article found.`, "success")}<button class="media-button" data-open-found>Open article</button>`;
        result.querySelector("[data-open-found]")?.addEventListener("click", () => void openArticle(data.article.id));
        return;
      }
      const metadata = data.metadata || {};
      result.innerHTML = `${data.metadata_error ? message(`Automatic metadata unavailable: ${data.metadata_error}. Supply the missing public fields manually.`) : message("New canonical article. Review metadata before adding.", "success")}
        <form class="media-inline-form" data-add-manual>
          <input type="hidden" name="url" value="${esc(data.canonical_url)}">
          <label class="media-field media-field--grow"><span>Publisher title</span><input name="title" required maxlength="1000" value="${esc(metadata.title || "")}"></label>
          <label class="media-field"><span>Publication</span><input name="publisher" required maxlength="200" value="${esc(metadata.publisher || data.source?.name || "")}"></label>
          <label class="media-field"><span>Author</span><input name="author" maxlength="500" value="${esc(metadata.author || "")}"></label>
          <label class="media-field"><span>Published</span><input name="published_at" type="datetime-local" value="${metadata.published_at ? esc(metadata.published_at.slice(0, 16)) : ""}"></label>
          <input type="hidden" name="preview_image_url" value="${esc(metadata.image_url || "")}">
          <button class="media-button media-button--primary">Add approved</button>
        </form><p class="media-subtext">Creation records status Approved and approval method Manual. ${data.source?.will_create_disabled_definition ? "A conservative disabled publisher definition will also be created." : ""}</p>`;
      result.querySelector("[data-add-manual]")?.addEventListener("submit", event => { event.preventDefault(); void addManualArticle(event.currentTarget, result); });
    } catch (error) { result.innerHTML = message(error.message, "error"); }
  }

  async function addManualArticle(form, result) {
    const values = new FormData(form);
    const published = String(values.get("published_at") || "");
    try {
      const data = await request("articles", { method: "POST", idempotent: "add", body: {
        url: values.get("url"), title: values.get("title"), publisher: values.get("publisher"),
        author: String(values.get("author") || "").trim() || null,
        published_at: published ? new Date(published).toISOString() : null,
        preview_image_url: String(values.get("preview_image_url") || "").trim() || null,
      } });
      result.innerHTML = message("Article added and approved with manual provenance.", "success");
      await renderArticles(false); await openArticle(data.article.id);
    } catch (error) { result.insertAdjacentHTML("afterbegin", message(error.message, "error")); }
  }

  function detailDialog() {
    let dialog = document.getElementById("media-article-detail");
    if (!dialog) { dialog = document.createElement("dialog"); dialog.id = "media-article-detail"; dialog.className = "media-detail"; document.body.appendChild(dialog); }
    return dialog;
  }

  async function openArticle(id) {
    const dialog = detailDialog();
    dialog.innerHTML = `<div class="media-detail__inner"><div class="media-loading">Loading article…</div></div>`;
    if (!dialog.open) dialog.showModal();
    try {
      const data = await request(`articles/${id}`); const article = data.article;
      const guardianRouteKeys = article.source_key === "the-guardian"
        ? [...new Set((data.discovery_evidence || []).map(item => item.route_key).filter(Boolean))]
        : [];
      dialog.innerHTML = `<div class="media-detail__inner"><div class="media-detail__header"><div><h3>${esc(article.display_title || article.title)}</h3><p>${esc(article.publisher)} · ${esc(STATUS_LABELS[article.status] || article.status)}</p></div><button class="media-button" data-close-detail>Close</button></div>
        <div class="media-detail__grid"><div>${article.admin_preview_image_path ? `<img class="media-detail__preview" src="${esc(apiUrl(`articles/${id}/image`))}" alt="">` : `<div class="media-thumb-fallback media-detail__preview">No permitted preview</div>`}</div>
        <dl><dt>Original title</dt><dd>${esc(article.title)}</dd><dt>Display title</dt><dd>${esc(article.display_title || "Publisher original")}</dd><dt>Title Status</dt><dd>${esc(titleStatus(article)[1])}</dd><dt>Title origin</dt><dd>${esc(article.display_title_origin || "original")}</dd><dt>AI suggestion</dt><dd>${esc(article.ai_title_suggestion || "—")} (${esc(article.ai_title_suggestion_state || "none")})</dd><dt>Canonical URL</dt><dd><a href="${esc(article.canonical_url)}" target="_blank" rel="noopener noreferrer">Open publisher ↗</a></dd><dt>Author</dt><dd>${esc(article.author || "—")}</dd><dt>Published</dt><dd>${esc(formatDate(article.published_at))}</dd><dt>Discovered</dt><dd>${esc(formatDate(article.discovered_at))}</dd><dt>Approved</dt><dd>${esc(formatDate(article.approved_at))}</dd><dt>Updated</dt><dd>${esc(formatDate(article.updated_at))}</dd><dt>Image policy</dt><dd>${esc(article.image_policy)} / source ${esc(article.source_image_policy)}</dd><dt>Approval</dt><dd>${esc(article.approval_method || "—")}${article.approval_author_rule_key ? ` · ${esc(article.approval_author_rule_key)}` : ""}</dd></dl></div>
        <section><h4>Article Status</h4><div class="media-inline-form" data-detail-status><label class="media-field"><span>Change to</span><select><option value="">Choose status…</option>${(STATUS_ACTIONS[article.status] || []).map(([next, label, action]) => `<option value="${next}" data-action="${action}">${esc(label)}</option>`).join("")}</select></label><button type="button" class="media-save-state" disabled aria-label="Saved/current" title="Saved/current">💾</button></div><div data-detail-status-message></div></section>
        <section><h4>Display title</h4><form class="media-inline-form" data-detail-title><label class="media-field media-field--grow"><span>Human display title</span><input name="display_title" maxlength="500" value="${esc(article.display_title || "")}"></label><button class="media-button media-button--primary">Save human title</button><button type="button" class="media-button" data-clear-title>Use publisher original</button></form><div data-detail-title-message></div></section>
        <section><h4>Reload metadata</h4><p>Fetches only source-policy-permitted bounded presentation metadata. Preview happens before mutation.</p>${article.source_key === "the-guardian" ? `<label class="media-field"><span>Guardian RSS route</span><select data-guardian-route>${guardianRouteKeys.length ? guardianRouteKeys.map(route => `<option value="${esc(route)}">${esc(route)}</option>`).join("") : `<option value="">No stored route evidence</option>`}</select></label>` : ""}<button class="media-button" data-reload-metadata>Reload metadata</button><div data-metadata-result></div></section>
        <section><details><summary>Discovery evidence and recent events</summary><pre>${esc(JSON.stringify({ discovery_evidence: data.discovery_evidence, events: data.events }, null, 2))}</pre></details></section></div>`;
      dialog.querySelector("[data-close-detail]")?.addEventListener("click", () => dialog.close());
      const detailStatus = dialog.querySelector("[data-detail-status]");
      detailStatus?.querySelector("select")?.addEventListener("change", event => {
        const button = detailStatus.querySelector("button");
        button.disabled = !event.currentTarget.value;
        button.classList.toggle("is-unsaved", Boolean(event.currentTarget.value));
        button.setAttribute("aria-label", event.currentTarget.value ? "Save status change" : "Saved/current");
        button.title = event.currentTarget.value ? "Save status change" : "Saved/current";
      });
      detailStatus?.querySelector("button")?.addEventListener("click", () => void saveDetailStatus(id, detailStatus, dialog));
      dialog.querySelector("[data-detail-title]")?.addEventListener("submit", event => { event.preventDefault(); void saveDetailTitle(id, new FormData(event.currentTarget).get("display_title"), dialog); });
      dialog.querySelector("[data-clear-title]")?.addEventListener("click", () => void saveDetailTitle(id, null, dialog));
      dialog.querySelector("[data-reload-metadata]")?.addEventListener("click", () => void reloadMetadata(id, article, dialog));
    } catch (error) { dialog.innerHTML = `<div class="media-detail__inner">${message(error.message, "error")}<button class="media-button" onclick="this.closest('dialog').close()">Close</button></div>`; }
  }

  async function saveDetailStatus(id, control, dialog) {
    const select = control.querySelector("select");
    const action = select.selectedOptions[0]?.dataset.action;
    const output = dialog.querySelector("[data-detail-status-message]");
    if (!action) return;
    control.querySelector("button").disabled = true;
    try {
      await request(`articles/${id}/${action}`, { method: "POST", idempotent: "status" });
      await renderArticles(false);
      await openArticle(id);
    } catch (error) {
      control.querySelector("button").disabled = false;
      output.innerHTML = message(error.message, "error");
    }
  }

  async function saveDetailTitle(id, value, dialog) {
    const output = dialog.querySelector("[data-detail-title-message]");
    try { await request(`articles/${id}/display-title`, { method: "PUT", body: { display_title: value === null ? null : String(value) } }); output.innerHTML = message(value === null ? "Publisher original restored." : "Human display title saved.", "success"); void renderArticles(false); }
    catch (error) { output.innerHTML = message(error.message, "error"); }
  }

  async function reloadMetadata(id, article, dialog) {
    const output = dialog.querySelector("[data-metadata-result]"); output.innerHTML = message("Reloading bounded publisher metadata…");
    try {
      if (article.source_key === "the-guardian") {
        const routeKey = dialog.querySelector("[data-guardian-route]")?.value;
        if (!routeKey) { output.innerHTML = message("No stored Guardian RSS route evidence is available for this article.", "error"); return; }
        const data = await request(`articles/${id}/guardian-image-refresh/preview`, { method: "POST", body: { route_key: routeKey } });
        const refresh = data.refresh;
        if (!refresh?.proposed_image || refresh.current_image?.url === refresh.proposed_image.url) {
          output.innerHTML = message("No useful metadata change found."); return;
        }
        output.innerHTML = `<div class="media-message"><strong>Proposed Guardian RSS image</strong><pre>${esc(JSON.stringify({ current: refresh.current_image, proposed: refresh.proposed_image }, null, 2))}</pre><button class="media-button media-button--primary" data-apply-guardian-image>${refresh.replacement_required ? "Replace image" : "Apply metadata"}</button></div>`;
        output.querySelector("[data-apply-guardian-image]")?.addEventListener("click", async () => {
          try {
            await request(`articles/${id}/guardian-image-refresh/apply`, { method: "POST", body: {
              route_key: routeKey,
              expected_current_image_url: refresh.current_image?.url ?? null,
              proposed_image_url: refresh.proposed_image.url,
              confirm_replace_existing: true,
            } });
            output.innerHTML = message("Guardian RSS preview image applied without changing editorial state.", "success");
            void renderArticles(false);
          } catch (error) { output.innerHTML = message(error.message, "error"); }
        });
        return;
      }
      const data = await request(`articles/${id}/metadata/preview`, { method: "POST" });
      if (!data.has_useful_change) { output.innerHTML = message("No useful metadata change found."); return; }
      output.innerHTML = `<div class="media-message"><strong>Proposed changes</strong><pre>${esc(JSON.stringify(data.changes, null, 2))}</pre><button class="media-button media-button--primary" data-apply-metadata>Apply metadata${data.changes.image?.replacement_required ? " / replace image" : ""}</button></div>`;
      output.querySelector("[data-apply-metadata]")?.addEventListener("click", async () => {
        try { await request(`articles/${id}/metadata/apply`, { method: "PUT", idempotent: "metadata", body: {
          expected_current_image_url: data.changes.image?.current ?? article.og_image_url ?? null,
          expected_proposed_image_url: data.changes.image?.expected_proposed_image_url ?? null,
          replace_existing_image: Boolean(data.changes.image?.replacement_required), apply_publisher_display_title: true,
        } }); output.innerHTML = message("Metadata applied without changing editorial state.", "success"); void renderArticles(false); }
        catch (error) { output.innerHTML = message(error.message, "error"); }
      });
    } catch (error) { output.innerHTML = message(error.message, "error"); }
  }

  function setAiPreviewMode(mode) {
    if (!AI_PREVIEW_MODES.includes(mode)) return;
    state.aiPreviewMode = mode;
    try { sessionStorage.setItem("media-ai-preview-mode", mode); } catch (_error) { /* Session persistence is optional. */ }
    const workspace = state.root.querySelector("[data-article-table]");
    if (!workspace) return;
    workspace.querySelectorAll("[data-ai-id]").forEach(row => AI_PREVIEW_MODES.forEach(value => row.classList.toggle(`media-ai-preview-mode--${value}`, value === mode)));
    state.root.querySelectorAll("[data-ai-preview-mode]").forEach(button => {
      const selected = button.dataset.aiPreviewMode === mode;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  async function hydrateAiPreviewDetail(row) {
    const id = row.dataset.aiId;
    if (!id || row.dataset.aiPublished === "true") return;
    let detail = articleDetailCache.get(id);
    if (!detail) {
      detail = request(`articles/${id}`).then(data => data?.article || null).catch(() => null);
      articleDetailCache.set(id, detail);
    }
    const article = await detail;
    const published = formatPublishedDate(article?.published_at);
    if (!published || !row.isConnected) return;
    const date = row.querySelector("[data-ai-preview-date]");
    if (date) date.textContent = ` · ${published}`;
    row.dataset.aiPublished = "true";
  }

  function hydrateAiPreviewDetails() {
    const rows = [...state.root.querySelectorAll("[data-ai-id]")];
    const pending = rows.filter(row => row.dataset.aiPublished !== "true");
    if (!("IntersectionObserver" in window)) {
      pending.forEach(row => void hydrateAiPreviewDetail(row));
      return;
    }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      void hydrateAiPreviewDetail(entry.target);
    }), { rootMargin: "160px" });
    pending.forEach(row => observer.observe(row));
  }

  function bindAiActions() {
    state.root.querySelectorAll("[data-ai-edit]").forEach(input => input.addEventListener("input", () => {
      const row = input.closest("[data-ai-id]");
      const title = row?.querySelector("[data-ai-preview-title]");
      if (title) title.textContent = input.value.trim() || input.dataset.aiSuggestion || "";
    }));
    state.root.querySelectorAll("[data-ai-preview-image]").forEach(image => image.addEventListener("error", () => image.remove(), { once: true }));
    state.root.querySelectorAll("[data-ai-action]").forEach(button => button.addEventListener("click", async () => {
      const row = button.closest("[data-ai-id]"); const id = row.dataset.aiId; const action = button.dataset.aiAction; const output = row.querySelector("[data-ai-message]");
      try {
        if (action === "accept-ai" || action === "reject-ai") await request(`articles/${id}/display-title/${action}`, { method: "POST" });
        if (action === "edit") await request(`articles/${id}/display-title`, { method: "PUT", body: { display_title: row.querySelector("[data-ai-edit]").value } });
        if (action === "clear") await request(`articles/${id}/display-title`, { method: "PUT", body: { display_title: null } });
        output.innerHTML = message("Title decision saved.", "success"); setTimeout(() => void refreshArticleTable(false), 350);
      } catch (error) { output.innerHTML = message(error.message, "error"); }
    }));
  }

  async function renderRuns(append) {
    if (!append) setView(`<section class="media-card"><div class="media-loading">Loading Runs…</div></section>`);
    try {
      const params = new URLSearchParams({ limit: "20" }); if (append && state.runsCursor) params.set("cursor", state.runsCursor);
      const data = await request("runs", { params });
      const rows = append ? (state.runRows || []).concat(data.runs || []) : (data.runs || []);
      state.runRows = rows; state.runsCursor = data.page?.next_cursor || null;
      setView(`<section class="media-card"><h3>Recent discovery runs</h3><p>Newest first; diagnostics are bounded to stored run evidence.</p><div class="media-table-wrap"><table class="media-table"><thead><tr><th>Publication</th><th>Route</th><th>Started</th><th>Duration</th><th>Status</th><th>Seen</th><th>Inserted</th><th>Updated</th><th>Filtered</th><th>Invalid</th><th>Diagnostics</th></tr></thead><tbody>${rows.length ? rows.map(run => `<tr><td>${esc(run.source_name || run.source_key || "System")}</td><td>${esc(run.discovery_route_key || "—")}</td><td>${esc(formatDate(run.started_at))}</td><td>${esc(duration(run.started_at, run.finished_at))}</td><td>${esc(run.status)}</td><td>${esc(run.items_seen)}</td><td>${esc(run.items_inserted)}</td><td>${esc(run.items_updated)}</td><td>${esc(run.items_filtered ?? 0)}</td><td>${esc(run.items_invalid)}</td><td>${run.error_code ? `<details><summary>${esc(run.error_code)}</summary><pre>${esc(JSON.stringify(run, null, 2))}</pre></details>` : "—"}</td></tr>`).join("") : `<tr><td colspan="11" class="media-empty">No discovery runs found.</td></tr>`}</tbody></table></div>${data.page?.has_more ? `<button class="media-button" data-load-more-runs>Load more</button>` : ""}</section>`);
      state.root.querySelector("[data-load-more-runs]")?.addEventListener("click", () => void renderRuns(true));
    } catch (error) { setView(`<section class="media-card"><h3>Runs</h3>${message(error.message, "error")}</section>`); }
  }

  async function renderSources() {
    setView(`<section class="media-card"><div class="media-loading">Loading Sources…</div></section>`);
    try {
      const data = await request("sources");
      const rulesBySource = new Map(); (data.author_rules || []).forEach(rule => { const group = rulesBySource.get(rule.source_key) || []; group.push(rule); rulesBySource.set(rule.source_key, group); });
      setView(`<section class="media-card"><div class="media-toolbar"><div><h3>Sources</h3><p>Policy changes apply to future discovery only.</p></div><button class="media-button media-button--primary" data-toggle-add-source>+ Add Source</button></div><div data-add-source></div><div class="media-source-list">${(data.sources || []).map(source => sourceCard(source, rulesBySource.get(source.source_key) || [])).join("") || `<div class="media-empty">No Media sources found.</div>`}</div></section>`);
      bindSourceActions();
    } catch (error) { setView(`<section class="media-card"><h3>Sources</h3>${message(error.message, "error")}</section>`); }
  }

  function sourceCard(source, rules) {
    let config = source.discovery_config_json; try { config = JSON.stringify(JSON.parse(config), null, 2); } catch (_error) {}
    return `<details class="media-source${source.enabled ? "" : " media-danger-zone"}" data-source-key="${esc(source.source_key)}"><summary>${esc(source.name)} · ${source.enabled ? "Enabled" : "Disabled"} · ${esc(source.publication_policy)}</summary><div class="media-source__grid">
      ${[["Canonical domain", source.canonical_domain], ["Source type", source.source_type], ["Discovery adapter", source.discovery_method], ["Review level", source.review_level], ["Content fetch", source.content_fetch_policy], ["AI content", source.ai_content_policy], ["Image policy", source.image_policy], ["Recent run", source.recent_run_status ? `${source.recent_run_status} · ${formatDate(source.recent_run_started_at)}` : "No run"]].map(([label, value]) => `<div><span class="media-subtext">${label}</span>${esc(value)}</div>`).join("")}
      <label class="media-field"><span>Publication policy</span><select data-source-policy><option value="manual"${source.publication_policy === "manual" ? " selected" : ""}>manual</option><option value="auto_approve"${source.publication_policy === "auto_approve" ? " selected" : ""}>auto_approve</option></select></label>
      <label class="media-field"><span>Enabled</span><select data-source-enabled><option value="false"${!source.enabled ? " selected" : ""}>No</option><option value="true"${source.enabled ? " selected" : ""}>Yes</option></select></label>
      <button class="media-button media-button--primary" data-save-source>Save source policy</button></div>
      <details><summary>Bounded route/configuration</summary><pre>${esc(config)}</pre></details><div data-source-message></div>
      <div class="media-author-rules"><div class="media-toolbar"><h4>Author rules</h4>${source.source_key === "the-guardian" ? `<button class="media-button" data-add-author>+ Add author rule</button>` : ""}</div><div data-add-author-form></div>
      ${rules.length ? rules.map(authorRuleRow).join("") : `<p>No author rules.</p>`}</div></details>`;
  }

  function authorRuleRow(rule) {
    let aliases = rule.byline_aliases;
    if (typeof aliases === "string") { try { aliases = JSON.parse(aliases); } catch (_error) { aliases = [aliases]; } }
    const identity = [rule.author_key, rule.profile_url, rule.profile_rss_url, ...(Array.isArray(aliases) ? aliases : [])].filter(Boolean).join(" · ");
    return `<div class="media-author-rule" data-author-key="${esc(rule.author_key)}"><div><strong>${esc(rule.display_name)}</strong><span class="media-subtext">${esc(identity)}</span></div><label class="media-field"><span>Inclusion</span><select data-author-inclusion><option value="normal"${rule.inclusion_policy === "normal" ? " selected" : ""}>normal</option><option value="always_include"${rule.inclusion_policy === "always_include" ? " selected" : ""}>always_include</option></select></label><label class="media-field"><span>Publication</span><select data-author-publication><option value="inherit_source"${rule.publication_policy === "inherit_source" ? " selected" : ""}>inherit_source</option><option value="pending"${rule.publication_policy === "pending" ? " selected" : ""}>pending</option><option value="auto_approve"${rule.publication_policy === "auto_approve" ? " selected" : ""}>auto_approve</option></select></label><label class="media-field"><span>Enabled</span><select data-author-enabled><option value="true"${rule.enabled ? " selected" : ""}>Yes</option><option value="false"${!rule.enabled ? " selected" : ""}>No</option></select></label><button class="media-button" data-save-author>Save rule</button></div>`;
  }

  function bindSourceActions() {
    state.root.querySelector("[data-toggle-add-source]")?.addEventListener("click", () => {
      const target = state.root.querySelector("[data-add-source]"); target.innerHTML = `<form class="media-inline-form media-message" data-add-source-form><label class="media-field"><span>Stable source key</span><input name="source_key" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*"></label><label class="media-field"><span>Display name</span><input name="name" required></label><label class="media-field"><span>Canonical domain</span><input name="canonical_domain" required placeholder="example.org"></label><label class="media-field"><span>Source type</span><select name="source_type"><option value="publisher">publisher</option><option value="government">government</option></select></label><button class="media-button media-button--primary">Create disabled definition</button></form><p class="media-subtext">Defaults: disabled, manual, standard, discovery metadata only, AI disabled, image blocked. No adapter or schedule is created.</p>`;
      target.querySelector("form")?.addEventListener("submit", event => { event.preventDefault(); void submitAddSource(event.currentTarget, target); });
    });
    state.root.querySelectorAll("[data-save-source]").forEach(button => button.addEventListener("click", () => void saveSource(button.closest("[data-source-key]"))));
    state.root.querySelectorAll("[data-save-author]").forEach(button => button.addEventListener("click", () => void saveAuthor(button.closest("[data-author-key]"))));
    state.root.querySelectorAll("[data-add-author]").forEach(button => button.addEventListener("click", () => showAddAuthor(button.closest("[data-source-key]"))));
  }

  async function saveSource(container) {
    const policy = container.querySelector("[data-source-policy]").value;
    const enabled = container.querySelector("[data-source-enabled]").value === "true";
    if (policy === "auto_approve" && !confirm("Auto-approve is a broad editorial decision for FUTURE discoveries. Existing rows will not change. Continue?")) return;
    const output = container.querySelector("[data-source-message]");
    try { await request(`sources/${container.dataset.sourceKey}`, { method: "PUT", idempotent: "source", body: { publication_policy: policy, enabled } }); output.innerHTML = message("Source policy saved for future discovery.", "success"); }
    catch (error) { output.innerHTML = message(error.message, "error"); }
  }

  async function saveAuthor(container) {
    const output = container.closest(".media-author-rules").querySelector("[data-source-message]") || container.closest(".media-source").querySelector("[data-source-message]");
    try { await request(`author-rules/${container.dataset.authorKey}`, { method: "PUT", idempotent: "author", body: { inclusion_policy: container.querySelector("[data-author-inclusion]").value, publication_policy: container.querySelector("[data-author-publication]").value, enabled: container.querySelector("[data-author-enabled]").value === "true" } }); if (output) output.innerHTML = message("Author rule saved for future discovery.", "success"); }
    catch (error) { if (output) output.innerHTML = message(error.message, "error"); else alert(error.message); }
  }

  function showAddAuthor(sourceContainer) {
    const target = sourceContainer.querySelector("[data-add-author-form]");
    target.innerHTML = `<form class="media-inline-form media-message" data-add-author-rule><label class="media-field"><span>Stable author key</span><input name="author_key" required placeholder="guardian:name-slug"></label><label class="media-field"><span>Display name</span><input name="display_name" required></label><label class="media-field media-field--grow"><span>Profile URL</span><input name="profile_url" type="url" required></label><label class="media-field"><span>Byline aliases (comma separated)</span><input name="aliases" required></label><button class="media-button media-button--primary">Add rule</button></form><p class="media-subtext">Guardian byline rules are supported. Adding a rule does not change source-wide policy.</p>`;
    target.querySelector("form")?.addEventListener("submit", event => { event.preventDefault(); void submitAddAuthor(event.currentTarget, sourceContainer.dataset.sourceKey, target); });
  }

  async function submitAddAuthor(form, sourceKey, target) {
    const values = new FormData(form);
    try { await request("author-rules", { method: "POST", idempotent: "author", body: { author_key: values.get("author_key"), source_key: sourceKey, display_name: values.get("display_name"), profile_url: values.get("profile_url"), profile_rss_url: null, profile_rss_route_key: null, inclusion_policy: "normal", publication_policy: "inherit_source", enabled: true, byline_aliases: String(values.get("aliases") || "").split(",").map(value => value.trim()).filter(Boolean) } }); target.innerHTML = message("Author rule added. It affects future discovery only.", "success"); setTimeout(() => void renderSources(), 350); }
    catch (error) { target.insertAdjacentHTML("afterbegin", message(error.message, "error")); }
  }

  async function submitAddSource(form, target) {
    const values = Object.fromEntries(new FormData(form));
    try { await request("sources", { method: "POST", idempotent: "source", body: values }); target.innerHTML = message("Disabled source definition created. It is not scheduled or trusted.", "success"); setTimeout(() => void renderSources(), 350); }
    catch (error) { target.insertAdjacentHTML("afterbegin", message(error.message, "error")); }
  }

  function mount(container, options = {}) {
    if (!container) return;
    state.root = container;
    state.apiBase = String(options.apiBaseUrl || "/api").replace(/\/+$/, "");
    if (!container.querySelector(".media-dashboard")) {
      container.innerHTML = `<div class="media-dashboard"><section class="media-header"><h2>Media</h2><p>Editorial administration for authoritative UK AQ Media D1.</p><nav class="media-mini-nav" role="tablist" aria-label="Media sections">${TABS.map(tab => `<button type="button" data-media-tab="${tab}" role="tab" aria-selected="${tab === state.tab}" class="${tab === state.tab ? "is-active" : ""}">${TAB_LABELS[tab]}</button>`).join("")}</nav></section><div data-media-view></div></div>`;
      container.querySelectorAll("[data-media-tab]").forEach(button => button.addEventListener("click", () => setTab(button.dataset.mediaTab)));
    }
    setTab(state.tab);
  }

  window.UKAQMediaDashboard = { mount, refresh: () => setTab(state.tab) };
})();
