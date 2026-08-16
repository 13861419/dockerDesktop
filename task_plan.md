# Task Plan: Compose Page Regression Coverage

## Goal
Add deterministic browser regression coverage for the Compose page, run it, fix any real defect it exposes, and re-verify the build.

## Phases
- [x] Phase 1: Pick the next regression target and record the plan
- [x] Phase 2: Research stable compose UI markers and interactions
- [x] Phase 3: Create the browser regression script
- [ ] Phase 4: Run the regression and fix real issues
- [ ] Phase 5: Run build verification and summarize results

## Key Questions
1. Does the Compose page render shell, list/empty state, and buttons without network/console errors?
2. Do read-only interactions (new-project modal, config viewer) stay stable without composing up/down/delete?

## Decisions Made
- Target `/compose` because it is a core, not-yet-covered page.
- Non-destructive: inspect shell, empty/list state, open the new-project modal (no create) and config modal (read-only) when a project exists.
- Do NOT click start/stop/restart/delete; do NOT submit the create form.

## Errors Encountered
- None yet.

## Status
**Currently in Phase 3** - creating the Compose page browser regression script.
