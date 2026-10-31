# Bounded schema-2 direct-verification implementation

Authority: accepted future exact-only contract; current TEST main includes merged
Ops #155 (`f41e23c`). Code only. No deployment, remote data operation, conversion,
consumer activation or original-evidence/receipt schema change.

1. Extend the existing shared scoped builder with explicit schema-2 construction;
   default schema-1 bytes and aligned graph remain unchanged. Derive immutable
   revisions with the shared canonical encoder. Schema-2 dependencies name files
   and the canonical pollutant body, with canonical prerequisites before leaves.
2. Add a read-only Node direct-verification module. Authenticate root/year/month/
   day/connector/pollutant bodies and aliases using existing hash validators, pin
   current identities, inspect/decode all pinned Parquet bytes independently,
   reconcile complete canonical membership, file counts/bounds and exact records.
   Reconstruct expected physical metadata with the existing inspector, never from
   supplied index claims. Explicitly support only proven physical schema 3;
   reject schema 4 pending an accepted inspector. No transient evidence cache.
3. Extend publication scheduling/finalisation for immutable dependencies, old
   selector identity checks under held exclusion, exact readback, completed-root
   acceptance and latest/run completion. Keep an unconditional schema-2
   operational publication gate until separately accepted consumer closure.
   Make preparation/reconciliation interfaces reviewable without activating them.
4. Expose the direct verifier for future Prune and independent post-write callers;
   retain current schema-1-only caller guards and receipt semantics. Document
   durable original handover integration as outstanding, not substitute authority.
5. Run syntax/import viability, the existing exact writer contract check and a
   necessary bounded in-memory canonical-identity/publication safety check.
   No new test suite or fixtures. Review the final branch, commit/push, open a PR
   against TEST main. Provide a Chat-mode documentation handover.

Repository/user structural-only validation policy supersedes generic TDD and broad
baseline-test recommendations. Existing daily archives are retained exactly.
