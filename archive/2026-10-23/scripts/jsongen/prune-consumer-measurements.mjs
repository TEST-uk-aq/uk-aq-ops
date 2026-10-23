// Bounded counters only. Heap observations are a sampled lower bound on peak
// heap, not a heap cap; OS maxRSS is process-wide, not event-attributed memory.
import { performance } from 'node:perf_hooks';

export function measurePruneConsumer(originalBudget) {
  const started = performance.now(), cpu = process.cpuUsage();
  let authStarted = null, authenticationMs = null, heap = 0, samples = 0, checks = 0;
  let attempts = 0, responses = 0, transferBytes = 0;
  const sample = () => { heap = Math.max(heap, process.memoryUsage().heapUsed); samples++; };
  sample();
  const timer = setInterval(sample, 25); timer.unref();
  const budget = { ...originalBudget,
    check() { originalBudget.check(); if (++checks % 32 === 0) sample(); },
    get(domain) { originalBudget.get(domain); attempts++; },
    transfer(_domain, bytes) { responses++; transferBytes += bytes; sample(); },
  };
  return {
    budget,
    stage() { budget.check(); sample(); },
    beginAuthentication() { authStarted = performance.now(); sample(); },
    authenticationFinished() { authenticationMs = Math.ceil(performance.now() - authStarted); sample(); },
    finish() {
      clearInterval(timer); sample();
      const used = process.cpuUsage(cpu);
      return { elapsed_ms: Math.ceil(performance.now() - started), authentication_elapsed_ms: authenticationMs,
        measurement_scope: 'event_read_authentication_and_planning_excludes_cli_serialization',
        cpu_user_ms: used.user / 1000, cpu_system_ms: used.system / 1000,
        sampled_peak_heap_used_bytes: heap, heap_samples: samples,
        heap_measurement: 'stage_budget_and_interval_samples_not_exact_peak',
        process_max_rss_bytes: process.resourceUsage().maxRSS * 1024,
        rss_measurement: 'process_lifetime_high_water_not_event_attributed',
        private_r2_get_attempts: attempts, private_r2_get_responses: responses,
        private_r2_response_body_bytes: transferBytes,
        transfer_accounting: responses === attempts ? 'complete_response_bodies_excludes_protocol_overhead'
          : 'incomplete_failed_or_interrupted_transport_bytes_unknown' };
    },
  };
}
