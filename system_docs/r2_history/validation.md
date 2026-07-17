# Binding validation

Focused local validation must prove stable payload serialization, core-row field
resolution, immutable binding API reads, and cache-proxy lookup order. The
history-integrity final verification compares available binding objects to the
imported core snapshot, reports missing/stale/invalid objects, and does not
delete them. External R2, Dropbox, database, deployment and backfill checks are
manual operational validation, not local tests.
