# Stage 2M protected diagnostic implementation plan

Base TEST main `afa50875c090919d4147dca200ae6795f06762b2`; authoritative system-docs `4e1cf595a0bcec5904febdd3bd1ea23616a592eb`, accepted Stage 2M amendment. Structural assessment completed before implementation/tests.

Use an explicit manual TEST flag on the existing fixed-v3 coordinator. After its unchanged request-wide boundary, original global lock, complete checkpoint and locked root equality, return through a separate diagnostic branch before normal preflight/source/planning/SQLite/repair. The existing holder/supervisor recognizes the same coordinator; no new IPC or lock session is needed.

- Archive existing coordinator, Python original-channel module and Stage 2K producer before changes.
- Add a bounded local-only preparation worker: consume accepted checkpoint/baseline and explicit one-day/source/pollutant selection; copy the complete unmasked canonical+latest input set byte-exactly into private run scratch, independently produce/validate v1 preparation and write the full input/sidecar handoff. No repair source acquisition or changed overlay is supported by this first diagnostic entry point.
- Add one distinct protected Node diagnostic child through a strict one-shot Python `popen_diagnostic`, reusing Stage 2J fd/channel. Authenticate and consume the complete run-local handoff; independently validate preparation, recheck original baseline provenance, invoke unchanged Stage 2L and emit only bounded non-executable summary diagnostics. No writer adapter or normal APPLY flag is accepted.
- Keep all preparation/ordinary APPLY/scheduling rejection and publication guards unchanged. Permit colon characters in Stage 2K's run-ID filename check because genuine retained coordinator run IDs use `integrity:TEST:<timestamp>`; preserve v1 directory/freeze/body-reference meanings.
- Outer coordinator owns temporary scratch across the retained-lock subprocess and removes it only after the holder has stopped the protected process group and returned/released. Private preparation/handoff/snapshot files never become a permanent proof store. Results live in the existing report directory, contain no bodies/credentials/descriptors, and never claim repair/finalisation.
- Require explicit manual TEST one-day pollutant selection and a finite runtime (default 5, maximum 30 minutes). Reject scheduler provenance, repair/write flags, internal workspace overrides without a real protected descriptor, and non-v3 targets. The child requires the genuine channel; no standalone current R2 operation is available.
- Add only necessary focused safety checks after this assessment: selector/writer separation, one-shot handoff, actual protected chain/cleanup under local ownership/R2 substitutes, unsupported preparation, and unchanged normal rejection. Run syntax/import/compilation and diff checks, then independent review.
- Commit/push working branch and create TEST-main PR; no merge/deploy/remote operation.

Review focus: complete source membership and snapshot provenance; bounded handoff; no descriptor leak; failure/timeout/cancellation and outer scratch cleanup; accurate diagnostic status; no mutation path or authority. Real PostgreSQL continuity and real TEST acceptance remain separately authorised work.

## Execution record

Structural assessment, implementation, exact archives and focused validation completed. All 26 directly relevant checks pass, along with JS syntax/import, Python compilation, archive/base and diff checks. Normal guards, JS transport, holder/supervisor, L helper and publication flag are unchanged. CodeQL already covers Python.

Independent review's three Important findings were corrected: diagnostic-only outer signal forwarding waits for holder cleanup before scratch removal; failed child results retain the bound run identity and reason; registry lexical/cardinality admission precedes parsing/traversal. No deferred minor issues.

Rulings: support unchanged existing nonempty baseline scopes first, with complete unmasked byte-pinned transient snapshots and no source acquisition/overlay; this leaves changed-source diagnostics unavailable. Permit safe colons for genuine original coordinator run IDs without changing v1 meanings; traversal remains rejected. Use the existing bounded Stage 2J process-stop observation for asynchronous kernel termination, without claiming real PostgreSQL or deployed shutdown acceptance. No additional contract decision was needed for this subset.
