You are working in the UK AQ ops repo.

Repos:
- Test repo: https://github.com/ChronicChannel-test/uk-aq-ops
- Live repo: https://github.com/Chronic-Illness-Channel/uk-aq-ops

Context:
We recently saw a Cloud Scheduler execution for the test Supabase DB dump backup trigger report failure:

- Scheduler job: uk-aq-supabase-db-dump-backup-trigger
- Target Cloud Run service: uk-aq-supabase-db-dump-backup-service
- Endpoint: POST /run-backup
- Scheduler log status: 502 / URL_UNREACHABLE-UNREACHABLE_5xx
- The actual backup completed successfully afterwards.
- Cloud Run service timeout was already 1800s.
- Cloud Scheduler attemptDeadline was already 1800s.
- The backup service records started/finished/failed status into the daily task health table, so Scheduler does not need to be the source of truth for the backup outcome.

Important goal:
I want to understand whether Cloud Scheduler jobs should be treated as “trigger delivery only” for long-running services. In other words, for some jobs, the service could reply quickly once the trigger has been accepted, so Scheduler marks the trigger as successful. The actual task result would then be monitored via the daily task health table, not via Scheduler’s HTTP result.

Please do NOT start coding yet. This is an investigation/design task only.

Please analyse ALL relevant GCP triggers/jobs/services in this repo and produce recommendations.

Scope:
1. Find all Cloud Scheduler setup scripts, Cloud Run service deploy scripts, and related worker/service endpoints in the repo.
2. Build an inventory of scheduled GCP triggers:
   - Scheduler job name
   - Target Cloud Run service
   - Target endpoint/path
   - Schedule
   - attemptDeadline
   - retry settings
   - Cloud Run timeout
   - CPU/memory/concurrency/min/max instance settings where available
   - Whether the service writes to daily task health
   - Whether the endpoint currently waits for the full job to finish before replying
   - Typical/expected runtime if this can be inferred from docs, logs guidance, code comments, or task behaviour
3. Categorise jobs into:
   - Fast jobs where synchronous Scheduler behaviour is probably fine
   - Medium jobs where either approach could be acceptable
   - Long-running or fragile jobs where Scheduler should probably only confirm trigger acceptance
4. Specifically analyse whether the Supabase DB dump backup trigger should change semantics so:
   - Scheduler POSTs the trigger
   - service validates/accepts the trigger
   - service records a started/queued/running state in the daily task health table
   - service replies quickly to Scheduler, likely 200 or 202
   - actual success/failure is determined by the task health table

Please consider these options at minimum:

Option A — Keep synchronous request
- Scheduler waits for the full task to complete.
- Pros, cons, failure modes, operational complexity.
- How to avoid false alarms when Scheduler reports failure but task health says success.

Option B — Quick “accepted” response from the service
- Scheduler only verifies that the trigger was accepted.
- Task health table becomes the source of truth for success/failure.
- Analyse whether this is safe on Cloud Run Services, especially with CPU throttling after response.
- Pros, cons, failure modes, operational complexity.

Option C — Split trigger and worker endpoints
- Scheduler calls a quick /trigger or /enqueue endpoint.
- A separate long-running worker endpoint/process does the actual work.
- Analyse whether this improves reliability or just moves the long HTTP request elsewhere.
- Pros, cons, failure modes, operational complexity.

Option D — Queue/run table model
- Scheduler creates/requests a queued run.
- Service/worker processes queued runs with locking/idempotency.
- Daily task health remains authoritative.
- Pros, cons, failure modes, operational complexity.

Option E — Keep Cloud Run Service but adjust CPU/min instance settings
- Analyse whether no CPU throttling and/or min instances would be needed for safe post-response background processing.
- Include cost/reliability trade-offs, but do not over-focus on cost.

Important constraints:
- Do NOT recommend switching to Cloud Run Jobs as the primary answer. Cloud Run Jobs are not suitable here because I cannot tune CPU/memory small enough for the way I want to run these tasks.
- Do NOT spend time analysing Supabase egress or database size effects. I already know these changes will not materially change Supabase egress or DB size.
- Do NOT implement code changes yet.
- Do NOT make changes outside the repo.
- Do NOT change production/live behaviour.
- Focus on design, reliability, observability, and operational meaning of “Scheduler success”.

Questions to answer:
1. Which scheduled tasks are good candidates for “trigger accepted quickly, task health owns final status”?
2. Which tasks should remain synchronous because they are quick and simple?
3. For long tasks, what is the safest design on Cloud Run Services?
4. Would setting Scheduler attemptDeadline back to 300s be reasonable for quick-accept endpoints?
5. What safeguards are needed to prevent duplicate overlapping runs?
6. What task-health statuses/fields are already present and are they enough to support this?
7. What alerting/monitoring changes would be needed so we alert on task-health failure/missing completion rather than Scheduler HTTP failure?
8. What specific implementation plan would you recommend, split into phases?
9. Which files would likely need changing in a future implementation?
10. Are there any deploy script/config drifts between test and live that affect this decision?

Deliverables:
- A Markdown investigation report.
- A table inventory of all relevant GCP scheduled triggers/services.
- Options with pros/cons/failure modes/operational complexity.
- A clear recommendation.
- A phased implementation plan, but no code changes.
- Explicitly identify any areas where more live/test GCP config or logs are needed before implementation.