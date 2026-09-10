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
