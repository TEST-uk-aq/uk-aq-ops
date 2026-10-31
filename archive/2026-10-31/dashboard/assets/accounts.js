(() => {
  "use strict";

  const STATUSES = ["pending", "active", "unsubscribed", "blocked"];
  const SORTS = [["created_at", "Created"], ["updated_at", "Updated"], ["email", "Email"], ["status", "Status"]];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_OFFSET = 10000;
  const ukDateTime = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Europe/London", timeZoneName: "short",
  });
  let state = null;

  function esc(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function label(value) {
    const text = String(value ?? "").replace(/_/g, " ");
    return text ? text[0].toUpperCase() + text.slice(1) : "Not recorded";
  }

  function timestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : ukDateTime.format(date).replace(",", "");
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-GB") : "Unavailable";
  }

  function badge(value) {
    const tone = ["active", "accepted"].includes(value) ? "good"
      : ["blocked", "permanent_failure", "failed"].includes(value) ? "bad"
        : ["pending", "queued", "temporary_failure", "held", "unknown"].includes(value) ? "waiting" : "neutral";
    return `<span class="accounts-pill accounts-pill--${tone}">${esc(label(value))}</span>`;
  }

  function preferencesRetained(subscription) {
    return subscription.consent_text_version !== "";
  }

  function dailyTime(subscription) {
    if (subscription.delivery_mode !== "daily") return "—";
    const time = String(subscription.daily_time_local || "");
    const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
    if (!match) return "Daily time not recorded";
    if (subscription.timezone !== "Europe/London") {
      return `${match[1]}:${match[2]} · ${subscription.timezone || "timezone not recorded"}`;
    }
    return `${match[1]}:${match[2]} Europe/London (GMT/BST)`;
  }

  function notice(text, error = false) {
    return `<p class="accounts-message${error ? " accounts-message--error" : ""}" role="${error ? "alert" : "status"}">${esc(text)}</p>`;
  }

  function errorText(status) {
    if (status === 401) return "Administrative sign-in is required. Sign in and refresh this page.";
    if (status === 403) return "Your identity is not authorised to view this private data.";
    if (status === 503) return "This private service is unavailable or has not been configured.";
    if (status === 409) return "The subscription changed or this action is unavailable. Refresh its details before trying again.";
    if (status === 400) return "These search or pagination options could not be accepted. Adjust the filters and try again.";
    return "The private data could not be loaded. Try refreshing this section.";
  }

  function cancel(session, key) {
    session.requests.get(key)?.abort();
    session.requests.delete(key);
  }

  function cancelAll(session) {
    session.requests.forEach(controller => controller.abort());
    session.requests.clear();
  }

  function begin(session, key) {
    cancel(session, key);
    const controller = new AbortController();
    session.requests.set(key, controller);
    return controller;
  }

  function current(session, key, controller) {
    return state === session && !controller.signal.aborted && session.requests.get(key) === controller;
  }

  async function request(path, params, controller, mutation = null) {
    // Subscriber queries must never use the public/configurable API base, storage or URL history.
    const query = params ? `?${params.toString()}` : "";
    const response = await fetch(`/api/accounts/${path}${query}`, {
      method: mutation ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { Accept: "application/json", ...(mutation ? {
        "Content-Type": "application/json", "X-UKAQ-Accounts-Action": "1",
      } : {}) }, signal: controller.signal,
      ...(mutation ? { body: JSON.stringify(mutation) } : {}),
    });
    if (!mutation && response.status === 404 && /^subscriptions\/[0-9a-f-]{36}$/i.test(path)) {
      return { subscription: null };
    }
    if (!response.ok) {
      // Fixed messages prevent an upstream response or URL from leaking private data into errors.
      throw new Error(errorText(response.status));
    }
    return response.json();
  }

  function pager(kind, offset, limit, size, hasMore) {
    const end = size ? offset + size : offset;
    const atBound = offset + limit > MAX_OFFSET;
    return `<div class="accounts-pagination"><p>${size ? `Rows ${(offset + 1).toLocaleString("en-GB")}–${end.toLocaleString("en-GB")}` : "No rows on this page"}${hasMore && atBound ? " · Narrow the filters to see more results." : ""}</p><div class="accounts-actions"><button type="button" class="accounts-button" data-page="${kind}" data-offset="${Math.max(0, offset - limit)}" ${offset === 0 ? "disabled" : ""}>Previous</button><button type="button" class="accounts-button" data-page="${kind}" data-offset="${offset + limit}" ${!hasMore || atBound ? "disabled" : ""}>Next</button></div></div>`;
  }

  function readPagination(payload, fallbackLimit, fallbackOffset) {
    const pagination = payload?.pagination;
    if (!pagination || !Number.isInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 100
        || !Number.isInteger(pagination.offset) || pagination.offset < 0 || pagination.offset > MAX_OFFSET
        || pagination.limit !== fallbackLimit || pagination.offset !== fallbackOffset
        || typeof pagination.has_more !== "boolean") throw new Error(errorText());
    return pagination;
  }

  function renderShell(session) {
    session.root.innerHTML = `<div class="accounts-dashboard"><section class="accounts-header"><h2>Accounts &amp; Subscriptions</h2><p>Private administration for AQ in the News subscriptions and email operations.</p><nav class="accounts-mini-nav" aria-label="Accounts &amp; Subscriptions sections">${[["subscriptions", "Subscriptions"], ["delivery", "Email Delivery"]].map(([tab, text]) => `<button type="button" data-accounts-tab="${tab}" aria-pressed="${session.tab === tab}" class="${session.tab === tab ? "is-active" : ""}">${text}</button>`).join("")}</nav></section><div data-accounts-view></div></div>`;
    const view = session.root.querySelector("[data-accounts-view]");
    if (session.tab === "subscriptions") {
      const filters = session.filters;
      view.innerHTML = `<section class="accounts-card"><div class="accounts-heading"><h3>Subscriptions</h3><span class="accounts-subtext">Private IngestDB source · AQ in the News</span></div><form class="accounts-filters" data-subscription-filters autocomplete="off"><label class="accounts-field accounts-field--search"><span>Email search</span><input name="search" type="search" maxlength="254" value="${esc(filters.search)}" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search by email"></label><label class="accounts-field"><span>Status</span><select name="status"><option value="">All statuses</option>${STATUSES.map(status => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${label(status)}</option>`).join("")}</select></label><label class="accounts-field"><span>Delivery mode</span><select name="delivery_mode"><option value="">All modes</option><option value="immediate" ${filters.delivery_mode === "immediate" ? "selected" : ""}>Immediate</option><option value="daily" ${filters.delivery_mode === "daily" ? "selected" : ""}>Daily</option></select></label><label class="accounts-field"><span>Sort by</span><select name="sort">${SORTS.map(([key, text]) => `<option value="${key}" ${filters.sort === key ? "selected" : ""}>${text}</option>`).join("")}</select></label><label class="accounts-field"><span>Direction</span><select name="direction"><option value="desc" ${filters.direction === "desc" ? "selected" : ""}>Descending</option><option value="asc" ${filters.direction === "asc" ? "selected" : ""}>Ascending</option></select></label><label class="accounts-field"><span>Rows</span><select name="limit">${[25, 50, 100].map(limit => `<option value="${limit}" ${session.limit === limit ? "selected" : ""}>${limit}</option>`).join("")}</select></label><button type="submit" class="accounts-button accounts-button--primary">Apply filters</button><button type="button" class="accounts-button" data-refresh>Refresh</button></form><p class="accounts-subtext">Search, filters and sorting are applied by the server. Dates use Europe/London (GMT/BST).</p><div data-subscription-results aria-live="polite"></div></section><section class="accounts-card" data-subscription-detail aria-live="polite" hidden></section>`;
      void loadSubscriptions(session);
    } else {
      view.innerHTML = `<section class="accounts-card"><div class="accounts-heading"><h3>Email Delivery</h3><button type="button" class="accounts-button" data-refresh>Refresh</button></div><p class="accounts-subtext">Authoritative Media D1 · last 7 days · dates use Europe/London (GMT/BST).</p><p class="accounts-subtext">Accepted means the outbound SMTP service accepted the email. It does not establish inbox delivery or that the recipient read it.</p>${session.deliverySubscription ? `<div class="accounts-history-filter"><span>History for subscription <span class="accounts-id">${esc(session.deliverySubscription)}</span></span><button type="button" class="accounts-button" data-clear-history>Show all recent delivery</button></div>` : ""}<div data-delivery-results aria-live="polite"></div></section>`;
      void loadDelivery(session);
    }
  }

  async function loadSubscriptions(session) {
    const controller = begin(session, "list");
    cancel(session, "detail");
    session.selectedId = null;
    session.subscription = null;
    session.items = [];
    const detail = session.root.querySelector("[data-subscription-detail]");
    detail.replaceChildren();
    detail.hidden = true;
    const target = session.root.querySelector("[data-subscription-results]");
    target.innerHTML = notice("Loading subscriptions…");
    const params = new URLSearchParams({ sort: session.filters.sort, direction: session.filters.direction,
      limit: String(session.limit), offset: String(session.offset) });
    ["search", "status", "delivery_mode"].forEach(key => {
      if (session.filters[key]) params.set(key, session.filters[key]);
    });
    try {
      const payload = await request("subscriptions", params, controller);
      if (!current(session, "list", controller)) return;
      if (!Array.isArray(payload?.items) || payload.items.length > session.limit || !payload.counts
          || !STATUSES.every(status => Number.isSafeInteger(payload.counts[status]) && payload.counts[status] >= 0)) {
        throw new Error(errorText());
      }
      const pagination = readPagination(payload, session.limit, session.offset);
      session.items = payload.items;
      target.innerHTML = `<div class="accounts-counts" aria-label="All subscriptions by status">${STATUSES.map(status => `<div><span>${label(status)}</span><strong>${count(payload.counts[status])}</strong></div>`).join("")}</div><p class="accounts-subtext">All subscriptions: source-reported totals by status, independent of the list filters.</p>${payload.items.length ? `<div class="accounts-table-scroll" tabindex="0" role="region" aria-label="Subscription results"><table class="accounts-table accounts-table--subscriptions"><thead><tr><th scope="col">Email / subscription UUID</th><th scope="col">Family</th><th scope="col">Status</th><th scope="col">Delivery</th><th scope="col">Confirmation</th><th scope="col">Created</th><th scope="col">Updated</th><th scope="col">Detail</th></tr></thead><tbody>${payload.items.map(subscription => `<tr><td><span class="accounts-email">${esc(subscription.email)}</span><span class="accounts-id">${esc(subscription.id)}</span></td><td>AQ in the News</td><td>${badge(subscription.status)}</td><td>${preferencesRetained(subscription) ? esc(label(subscription.delivery_mode)) : "Not retained"}${preferencesRetained(subscription) && subscription.delivery_mode === "daily" ? `<span class="accounts-subtext accounts-cell-note">${esc(dailyTime(subscription))}</span>` : ""}</td><td>${!preferencesRetained(subscription) ? "Not retained" : subscription.confirmed === true ? "Confirmed" : "Unconfirmed"}<span class="accounts-subtext accounts-cell-note">${timestamp(subscription.confirmed_at)}</span></td><td class="accounts-date">${timestamp(subscription.created_at)}</td><td class="accounts-date">${timestamp(subscription.updated_at)}</td><td>${UUID.test(subscription.id) ? `<button type="button" class="accounts-button" data-detail="${esc(subscription.id)}">View details</button>` : "Unavailable"}</td></tr>`).join("")}</tbody></table></div>` : notice("No subscriptions match these filters.")}${pager("subscriptions", pagination.offset, pagination.limit, payload.items.length, pagination.has_more)}`;
    } catch (error) {
      if (current(session, "list", controller)) target.innerHTML = notice(error instanceof TypeError || error instanceof SyntaxError ? errorText() : error.message, true);
    }
  }

  function detailField(name, value) {
    return `<div><dt>${esc(name)}</dt><dd>${esc(value ?? "Not recorded")}</dd></div>`;
  }

  async function loadDetail(session, id) {
    if (!UUID.test(id)) return;
    const controller = begin(session, "detail");
    session.selectedId = id;
    const target = session.root.querySelector("[data-subscription-detail]");
    target.hidden = false;
    target.innerHTML = notice("Loading subscription detail…");
    try {
      const payload = await request(`subscriptions/${encodeURIComponent(id)}`, null, controller);
      if (!current(session, "detail", controller) || session.selectedId !== id) return;
      if (payload?.subscription === null) {
        target.innerHTML = notice("This subscription is no longer available.");
        return;
      }
      const subscription = payload?.subscription;
      if (!subscription || subscription.id !== id) throw new Error(errorText());
      session.subscription = subscription;
      const dates = [["Created", "created_at"], ["Updated", "updated_at"], ["Confirmed", "confirmed_at"],
        ["Unsubscribed", "unsubscribed_at"], ["Blocked", "blocked_at"],
        ["Confirmation last sent", "confirmation_last_sent_at"], ["Confirmation held until", "confirmation_suppressed_until"],
        ["Consent recorded", "consent_recorded_at"]];
      target.innerHTML = `<div class="accounts-heading"><h3>Subscription detail</h3><button type="button" class="accounts-button" data-close-detail>Close detail</button></div><p class="accounts-email">${esc(subscription.email)}</p><p class="accounts-id">${esc(subscription.id)}</p><dl class="accounts-detail-grid">${detailField("Family", "AQ in the News")}${detailField("Status", label(subscription.status))}${detailField("Confirmation", !preferencesRetained(subscription) ? "Not retained" : subscription.confirmed === true ? "Confirmed" : "Unconfirmed")}${detailField("Delivery mode", preferencesRetained(subscription) ? label(subscription.delivery_mode) : "Not retained")}${preferencesRetained(subscription) && subscription.delivery_mode === "daily" ? detailField("Daily wall time", dailyTime(subscription)) : ""}${detailField("Timezone", subscription.timezone || "Not recorded")}${detailField("Consent text version", subscription.consent_text_version || "Not retained")}${dates.filter(([, key]) => ["created_at", "updated_at", "confirmed_at"].includes(key) || Object.hasOwn(subscription, key)).map(([text, key]) => detailField(`${text} (UK)`, timestamp(subscription[key]))).join("")}${Object.hasOwn(subscription, "confirmation_send_count") ? detailField("Confirmation send count", count(subscription.confirmation_send_count)) : ""}${subscription.block_reason ? detailField("Block reason", subscription.block_reason) : ""}</dl><button type="button" class="accounts-button" data-history="${esc(id)}">View email delivery history</button>${subscriberControls(subscription)}`;
    } catch (error) {
      if (current(session, "detail", controller)) target.innerHTML = notice(error instanceof TypeError || error instanceof SyntaxError ? errorText() : error.message, true);
    }
  }

  function subscriberControls(subscription) {
    const active = subscription.status === "active";
    const blocked = subscription.status === "blocked";
    return `<section><h4>Subscriber actions</h4>${active ? `<form class="accounts-filters" data-edit-preferences autocomplete="off"><label class="accounts-field"><span>Delivery mode</span><select name="delivery_mode"><option value="immediate" ${subscription.delivery_mode === "immediate" ? "selected" : ""}>Immediate</option><option value="daily" ${subscription.delivery_mode === "daily" ? "selected" : ""}>Daily</option></select></label><label class="accounts-field"><span>Daily time · Europe/London (GMT/BST)</span><input name="daily_time_local" type="time" step="60" required value="${esc(String(subscription.daily_time_local || "08:00").slice(0,5))}"></label><button type="submit" class="accounts-button">Save delivery preferences</button></form>` : `<p class="accounts-subtext">Delivery preferences can be edited while active.</p>`}<div class="accounts-actions">${blocked ? `<button type="button" class="accounts-button" data-subscriber-action="unblock">Unblock</button>` : `<button type="button" class="accounts-button" data-subscriber-action="block">Block</button>${subscription.status !== "unsubscribed" ? `<button type="button" class="accounts-button" data-subscriber-action="unsubscribe">Unsubscribe</button>` : ""}`}<button type="button" class="accounts-button" data-subscriber-action="delete">Delete subscription</button></div><p class="accounts-subtext">Unblock returns to pending. The subscriber must subscribe again and confirm their email before delivery resumes.</p><div data-action-result role="status"></div></section>`;
  }

  async function subscriberAction(session, action, preferences = {}) {
    const subscription = session.subscription;
    if (session.mutating || !subscription || subscription.id !== session.selectedId) return;
    const id = subscription.id;
    const descriptions = {
      edit: `Save ${label(preferences.delivery_mode)} delivery${preferences.delivery_mode === "daily" ? ` at ${preferences.daily_time_local} Europe/London` : ""}?`,
      block: "Block this subscriber? This prevents new News and confirmation sends, including public resubscription.",
      unblock: "Unblock into pending? No email is sent by this action. Fresh public subscription and email confirmation are required before delivery resumes.",
      unsubscribe: "Unsubscribe this subscriber and revoke their current management links? New News sends will stop.",
      delete: "Permanently delete this subscription and its confirmation/management links? Historical email delivery records remain. This address may subscribe again with a new identity and fresh confirmation.",
    };
    if (!Object.hasOwn(descriptions, action)) return;
    let reason;
    if (action === "block") {
      reason = window.prompt("Short reason for blocking (1–200 characters; do not include sensitive information):");
      if (reason === null) return;
      reason = reason.trim();
      if (!reason || reason.length > 200 || /[\x00-\x1f\x7f]/.test(reason)) {
        window.alert("Enter a reason of 1–200 characters on one line."); return;
      }
    }
    if (!window.confirm(`${subscription.email}\n\n${descriptions[action]}`)) return;
    session.mutating = true;
    const controller = begin(session, "mutation");
    const target = session.root.querySelector("[data-action-result]");
    target.innerHTML = notice("Saving subscriber action…");
    const controls = session.root.querySelectorAll("button, input, select");
    controls.forEach(control => { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; });
    try {
      const result = await request(`subscriptions/${encodeURIComponent(id)}/actions`, null, controller,
        { action, confirmed: true, expected_updated_at: subscription.updated_at, ...preferences,
          ...(action === "block" ? { reason } : {}) });
      if (!current(session, "mutation", controller)) return;
      if (result?.ok !== true || result.subscription_id !== id || (action === "delete" && result.deleted !== true)) {
        throw new Error("The action result could not be confirmed. Refresh before trying again.");
      }
      await loadSubscriptions(session);
      if (state !== session) return;
      if (action !== "delete") {
        await loadDetail(session, id);
        const message = session.root.querySelector("[data-action-result]");
        if (message) message.innerHTML = notice("Subscriber action saved.");
      } else {
        session.root.querySelector("[data-subscription-results]").insertAdjacentHTML("afterbegin", notice("Subscription deleted. Historical email delivery records are preserved."));
      }
    } catch (error) {
      if (current(session, "mutation", controller)) target.innerHTML = notice(
        `${error instanceof TypeError || error instanceof SyntaxError ? "The action result could not be confirmed." : error.message} Refresh before retrying.`, true);
    } finally {
      session.mutating = false;
      controls.forEach(control => { control.disabled = control.dataset.wasDisabled === "true"; delete control.dataset.wasDisabled; });
    }
  }

  function deliveryTable(deliveries) {
    return `<h4>Recent delivery outcomes</h4>${deliveries.length ? `<div class="accounts-table-scroll" tabindex="0" role="region" aria-label="Recent delivery outcomes"><table class="accounts-table accounts-table--delivery"><thead><tr><th scope="col">Delivery / subscription UUID</th><th scope="col">Mode</th><th scope="col">State</th><th scope="col">Created</th><th scope="col">Sent at (source)</th><th scope="col">Failed</th><th scope="col">Attempts</th><th scope="col">Transport / attempt</th><th scope="col">Retry hold</th><th scope="col">Error class</th></tr></thead><tbody>${deliveries.map(delivery => `<tr><td><span class="accounts-id">${esc(delivery.id)}</span><span class="accounts-id">${esc(delivery.subscription_id)}</span></td><td>${esc(label(delivery.delivery_mode))}</td><td>${badge(delivery.state)}</td><td class="accounts-date">${timestamp(delivery.created_at)}</td><td class="accounts-date">${timestamp(delivery.sent_at)}</td><td class="accounts-date">${timestamp(delivery.failed_at)}</td><td>${count(delivery.attempt_count)}</td><td>${esc(delivery.selected_transport || "—")}<span class="accounts-cell-note">${esc(delivery.attempt_transport || "—")}</span></td><td>${delivery.retry_hold === true ? "Held" : delivery.retry_hold === false ? "No" : "—"}</td><td>${esc(delivery.error_class || "—")}</td></tr>`).join("")}</tbody></table></div>` : notice("No delivery outcomes were returned for this page and time window.")}`;
  }

  function outboxTable(outbox) {
    return `<h4>Recent outbox work</h4>${outbox.length ? `<div class="accounts-table-scroll" tabindex="0" role="region" aria-label="Recent outbox work"><table class="accounts-table"><thead><tr><th scope="col">Work ID</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Created</th><th scope="col">Queued</th><th scope="col">Attempts</th><th scope="col">Error class</th></tr></thead><tbody>${outbox.map(item => `<tr><td class="accounts-id">${esc(item.id)}</td><td>${esc(label(item.work_type))}</td><td>${badge(item.state)}</td><td class="accounts-date">${timestamp(item.created_at)}</td><td class="accounts-date">${timestamp(item.queued_at)}</td><td>${count(item.attempt_count)}</td><td>${esc(item.error_class || "—")}</td></tr>`).join("")}</tbody></table></div>` : notice("No outbox work was returned for this page and time window.")}`;
  }

  async function loadDelivery(session) {
    const controller = begin(session, "delivery");
    const target = session.root.querySelector("[data-delivery-results]");
    target.innerHTML = notice("Loading email delivery…");
    const params = new URLSearchParams({ limit: "25", offset: String(session.deliveryOffset), days: "7" });
    if (session.deliverySubscription) params.set("subscription_id", session.deliverySubscription);
    try {
      const payload = await request("email-delivery", params, controller);
      if (!current(session, "delivery", controller)) return;
      if (payload?.available === false) {
        target.innerHTML = notice("Email Delivery is unavailable. A protected, bounded Media delivery read capability is not ready.");
        return;
      }
      if (payload?.available !== true || !Array.isArray(payload.summary) || !Array.isArray(payload.deliveries)
          || !Array.isArray(payload.outbox) || payload.deliveries.length > 25 || payload.outbox.length > 25
          || payload.window_days !== 7) throw new Error(errorText());
      const pagination = readPagination(payload, 25, session.deliveryOffset);
      target.innerHTML = `<h4>Source-reported summary</h4>${payload.summary.length ? `<div class="accounts-table-scroll" tabindex="0" role="region" aria-label="Delivery summary"><table class="accounts-table accounts-table--summary"><thead><tr><th scope="col">Mode / work type</th><th scope="col">State</th><th scope="col">Count</th></tr></thead><tbody>${payload.summary.map(item => `<tr><td>${esc(label(item.delivery_mode))}</td><td>${badge(item.state)}</td><td>${count(item.count)}</td></tr>`).join("")}</tbody></table></div>` : notice("No delivery summary was returned for this time window.")}${deliveryTable(payload.deliveries)}${outboxTable(payload.outbox)}${pager("delivery", pagination.offset, pagination.limit, Math.max(payload.deliveries.length, payload.outbox.length), pagination.has_more)}`;
    } catch (error) {
      if (current(session, "delivery", controller)) target.innerHTML = notice(`Email Delivery unavailable. ${error instanceof TypeError || error instanceof SyntaxError ? errorText() : error.message}`, true);
    }
  }

  function setTab(session, tab) {
    if (!["subscriptions", "delivery"].includes(tab)) return;
    cancelAll(session);
    session.items = [];
    session.selectedId = null;
    session.subscription = null;
    session.tab = tab;
    renderShell(session);
  }

  function closeDetail(session) {
    cancel(session, "detail");
    session.selectedId = null;
    session.subscription = null;
    const target = session.root.querySelector("[data-subscription-detail]");
    target.replaceChildren();
    target.hidden = true;
  }

  function refresh() {
    if (!state || state.mutating) return;
    if (state.tab === "subscriptions") void loadSubscriptions(state);
    else void loadDelivery(state);
  }

  function mount(root) {
    if (!root || state?.root === root) return;
    unmount();
    const session = { root, tab: "subscriptions", requests: new Map(), items: [], selectedId: null, subscription: null, mutating: false,
      filters: { search: "", status: "", delivery_mode: "", sort: "created_at", direction: "desc" },
      limit: 25, offset: 0, deliveryOffset: 0, deliverySubscription: null, listeners: new AbortController() };
    state = session;
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || !root.contains(button) || button.disabled || session.mutating) return;
      if (button.hasAttribute("data-subscriber-action")) {
        void subscriberAction(session, button.dataset.subscriberAction);
      } else if (button.hasAttribute("data-accounts-tab")) {
        if (session.tab !== button.dataset.accountsTab) setTab(session, button.dataset.accountsTab);
      } else if (button.hasAttribute("data-refresh")) refresh();
      else if (button.hasAttribute("data-detail")) void loadDetail(session, button.dataset.detail);
      else if (button.hasAttribute("data-close-detail")) closeDetail(session);
      else if (button.hasAttribute("data-history") && UUID.test(button.dataset.history)) {
        session.deliverySubscription = button.dataset.history;
        session.deliveryOffset = 0;
        setTab(session, "delivery");
      } else if (button.hasAttribute("data-clear-history")) {
        session.deliverySubscription = null;
        session.deliveryOffset = 0;
        setTab(session, "delivery");
      } else if (button.hasAttribute("data-page")) {
        const offset = Number(button.dataset.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return;
        if (button.dataset.page === "subscriptions") {
          session.offset = offset;
          void loadSubscriptions(session);
        } else {
          session.deliveryOffset = offset;
          void loadDelivery(session);
        }
      }
    }, { signal: session.listeners.signal });
    root.addEventListener("submit", event => {
      if (event.target.matches("[data-edit-preferences]")) {
        event.preventDefault();
        const values = new FormData(event.target);
        void subscriberAction(session, "edit", { delivery_mode: String(values.get("delivery_mode")),
          daily_time_local: String(values.get("daily_time_local")) });
        return;
      }
      if (!event.target.matches("[data-subscription-filters]")) return;
      event.preventDefault();
      if (session.mutating) return;
      const values = new FormData(event.target);
      session.filters = { search: String(values.get("search") || "").trim().toLowerCase(),
        status: String(values.get("status") || ""), delivery_mode: String(values.get("delivery_mode") || ""),
        sort: String(values.get("sort") || "created_at"), direction: String(values.get("direction") || "desc") };
      session.limit = Math.min(100, Math.max(1, Number(values.get("limit")) || 25));
      session.offset = 0;
      void loadSubscriptions(session);
    }, { signal: session.listeners.signal });
    renderShell(session);
  }

  function unmount() {
    if (!state) return;
    const session = state;
    state = null;
    cancelAll(session);
    session.listeners.abort();
    session.root.querySelectorAll("input").forEach(input => { input.value = ""; });
    session.root.replaceChildren();
    session.filters.search = "";
    session.items = [];
    session.selectedId = null;
    session.subscription = null;
    session.deliverySubscription = null;
  }

  // Clear private content before a document enters the browser's back/forward cache.
  window.addEventListener("pagehide", unmount);
  window.addEventListener("pageshow", event => {
    if (event.persisted && window.location.pathname.replace(/\/$/, "") === "/accounts") {
      const root = document.querySelector('.mode-view[data-mode="accounts"]');
      if (root && !root.hidden) mount(root);
    }
  });

  window.UKAQAccountsDashboard = { mount, unmount, refresh };
})();
