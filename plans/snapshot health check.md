Yes. I’d definitely add this.

The failure mode is now fixed, but it exposed a wider weakness: the public site can silently keep serving old snapshots while the ingest dashboard looks healthy. That is exactly the kind of problem that should have a stale-snapshot alert.

I’d add two layers.

1. Snapshot builder logs should clearly say when a run did not produce a fresh manifest

The builder already emits structured logs now, so the next improvement is to make the final success log include enough fields to alert on:

{
  "event": "latest_snapshot_run_succeeded",
  "manifest_key": "latest_snapshots/v1/manifest.json",
  "manifest_generated_at": "2026-06-27T10:32:00Z",
  "duration_ms": 12345,
  "success_count": 15,
  "failure_count": 0,
  "changed_count": 6,
  "state_entries": 12345,
  "pubsub_pulled_messages": 800,
  "pubsub_acked_messages": 800
}

And if it runs but does not write a manifest, that should be a structured error:

{
  "event": "latest_snapshot_manifest_not_updated",
  "reason": "build_failed_or_manifest_write_skipped",
  "age_seconds": 3900,
  "threshold_seconds": 3600
}

But I would not rely only on builder logs, because if the builder stops running entirely, it may not log anything useful.

2. Add a separate snapshot health check

This is the more important bit.

Have a small scheduled check, maybe every 10 or 15 minutes, that reads the public/latest manifest from R2 and checks:

* does manifest.json exist?
* is generated_at less than 60 minutes old?
* does it contain expected pollutant/window entries?
* does pm25/6h/all exist?
* does pm25/6h/all have rows above a minimum threshold?
* optionally, do expected networks appear in the 6h snapshot?

For your specific incident, the best alert would have been:

Latest snapshot manifest has not advanced for over 60 minutes.

A better second-level check would be:

PM2.5 6h snapshot is missing expected networks: Breathe London, GOV.UK AURN.

Recommended threshold

I’d use:

Warn after 30 minutes stale.
Error after 60 minutes stale.

Because the scheduler runs every minute, an hour is already a long time. But 30 minutes warning avoids being too noisy if R2, Pub/Sub or Cloud Run has a short wobble.

Where to put it

Best option for your setup:

uk-aq-latest-snapshot-health-check

A tiny Cloud Run job or script triggered every 10 to 15 minutes.

It should emit structured logs like:

{
  "event": "latest_snapshot_health_check_failed",
  "severity": "ERROR",
  "reason": "manifest_stale",
  "manifest_generated_at": "2026-06-27T08:02:00Z",
  "age_seconds": 5460,
  "threshold_seconds": 3600
}

Then create a GCP log-based alert on:

event="latest_snapshot_health_check_failed"

My recommendation

Yes, add it, but make it a separate health checker, not just another log inside the builder.

The builder can tell you “my last run failed”.
The health checker tells you “the public data is stale”, which is the thing you actually care about.