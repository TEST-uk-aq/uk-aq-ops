---
name: UK AQ project rules
alwaysApply: true
---

# UK AQ project rules

This is a structural refactor only.


Do not change runtime behaviour, error handling, environment-variable
semantics, source filtering, evidence values, counts, logging, file paths,
R2 behaviour, Dropbox behaviour, proposal behaviour or repair behaviour.

Move existing code into a module, add explicit imports/exports, and update
the original call sites.

Before editing, identify every dependency used by the functions being moved.
Do not duplicate functions or leave an alternative implementation behind.
Do not make unrelated changes.

Do not implement any outstanding  behavioural fixes in this task.