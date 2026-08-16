# Task Plan: Networks Page Regression Coverage

## Goal
Add deterministic browser regression coverage for the networks page, run it, fix any real defect, and re-verify the build.

## Phases
- [x] Phase 1: Pick the next regression target and record the plan
- [x] Phase 2: Research stable networks UI markers and interactions
- [x] Phase 3: Create the browser regression script
- [ ] Phase 4: Run the regression and fix real issues
- [ ] Phase 5: Run build verification and summarize results

## Key Questions
1. Does the networks page render shell, list/empty state, and buttons without errors?
2. Does the read-only network-detail modal open and close cleanly?

## Decisions Made
- Target `/networks`: core, not-yet-covered, non-destructive to browse.
- Non-destructive: inspect shell, list/empty state, errors; open network detail modal (read-only) and close.
- Do NOT create/delete networks, do NOT prune, do NOT connect/disconnect containers.

## Errors Encountered
- None yet (note: several previous turns were lost to output-layer loops; keep responses tight).

## Status
**Currently in Phase 3**.
