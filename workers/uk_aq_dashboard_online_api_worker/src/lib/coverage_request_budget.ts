// Request-owned state only. Reserve ten of the Free plan's 50 calls for the
// serving descriptor, final authority check and telemetry. Cache calls count too.
export class CoverageRequestBudget {
  used = 0;
  readonly limit = 40;

  take(): void {
    if (this.used >= this.limit) throw new Error("Storage coverage subrequest budget exhausted");
    this.used++;
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.take();
    // A redirect chain must not spend uncounted requests or forward credentials.
    return fetch(input, { ...init, redirect: "manual" });
  }

  match(cache: Cache, request: Request): Promise<Response | undefined> {
    this.take();
    return cache.match(request);
  }

  put(cache: Cache, request: Request, response: Response): Promise<void> {
    this.take();
    return cache.put(request, response);
  }
}
