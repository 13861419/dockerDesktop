# Files and Events Regression Reinforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regress the files and events flows with deterministic browser coverage, fix any real defects found, and verify the pages remain stable after the fixes.

**Architecture:** Focus on two high-risk surfaces that already showed regressions: container file browsing and Docker event streaming. Use a small browser regression harness to reproduce issues first, then patch the narrow server/client code paths that own the behavior, and finish with build + browser verification.

**Tech Stack:** Node.js, TypeScript, Express, React, Playwright/Chrome, existing project scripts, existing Dockerode integration

## Global Constraints

- Windows environment.
- Do not add new runtime dependencies unless a real blocker proves one is required.
- Keep changes scoped to the files that own the broken behavior.
- Add function-level comments to any new functions.
- Verify with build and browser regression before considering the work done.

---

### Task 1: Create a deterministic browser regression harness

**Files:**
- Create: `f:\ai_work\dockerDesktop\scripts\regression-files-events.py`
- Modify: `f:\ai_work\dockerDesktop\package.json` only if a repo script is needed to invoke the harness cleanly

**Interfaces:**
- Consumes: existing admin login, `/files`, `/events`, and the app's current API/base URL
- Produces: a repeatable script that reports page load success, network failures, console errors, and the exact body lines that contain suspicious `404` or timestamp anomalies

- [ ] **Step 1: Write the failing harness**

```python
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:9526'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    ctx = browser.new_context(viewport={'width': 1600, 'height': 900})
    page = ctx.new_page()
    errors = []
    page.on('requestfailed', lambda r: errors.append(('requestfailed', r.url)))
    page.on('console', lambda m: errors.append(('console', m.text)))
    page.goto(BASE + '/login', wait_until='domcontentloaded', timeout=30000)
    page.goto(BASE + '/files', wait_until='domcontentloaded', timeout=30000)
    page.goto(BASE + '/events', wait_until='domcontentloaded', timeout=30000)
    print(page.title())
    browser.close()
```

- [ ] **Step 2: Run it and confirm it exposes current risk points**

Run: `python scripts/regression-files-events.py`
Expected: page-specific outputs for files/events plus any current failures or suspicious text lines

- [ ] **Step 3: Hook the harness into a repo script if needed**

If invoking the script manually is brittle, add a `package.json` script such as:

```json
{
  "scripts": {
    "regression:files-events": "python scripts/regression-files-events.py"
  }
}
```

- [ ] **Step 4: Verify the harness is stable**

Run: `npm run regression:files-events`
Expected: the same output on repeated runs without command-layer encoding issues

### Task 2: Reproduce and fix the files flow if the harness finds a real defect

**Files:**
- Modify: `f:\ai_work\dockerDesktop\server\src\routes\files.ts`
- Modify: `f:\ai_work\dockerDesktop\web\src\pages\files.tsx`

**Interfaces:**
- Consumes: current file list API contract (`/api/files/:id/ls`, `/read`, `/download`, write actions)
- Produces: stable directory listing, preview, upload, rename, and delete behavior under the current container/file permissions model

- [ ] **Step 1: Write a minimal repro note in the plan from the harness output**

Use the harness to isolate one concrete failure mode, such as malformed directory output, incorrect path handling, or a stale client state update.

- [ ] **Step 2: Implement the smallest server-side fix**

Example shape for a path normalization fix:

```ts
function sanitizePath(raw: string | undefined | null): string {
  const p = String(raw || '').trim();
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) {
    throw Object.assign(new Error('路径不能包含 ".."（禁止路径穿越）'), { statusCode: 400 });
  }
  if (!p) return '/';
  return '/' + segments.filter((s) => s !== '' && s !== '.').join('/');
}
```

- [ ] **Step 3: Mirror the fix in the page state if needed**

Example shape for a client state reset fix:

```ts
const handleSelectContainer = (id: string) => {
  setSelectedId(id);
  setCrumbs(['/']);
  setItems([]);
};
```

- [ ] **Step 4: Re-run the harness against the files page**

Run: `python scripts/regression-files-events.py`
Expected: the files flow no longer shows the reproduced defect

### Task 3: Reproduce and fix the events flow if the harness finds a real defect

**Files:**
- Modify: `f:\ai_work\dockerDesktop\server\src\docker\events.ts`
- Modify: `f:\ai_work\dockerDesktop\web\src\pages\events.tsx`

**Interfaces:**
- Consumes: `/api/events` REST payload and `/ws/events` WebSocket payload
- Produces: stable event timestamps, predictable event list rendering, and no false-positive error text in the event page body

- [ ] **Step 1: Keep the timestamp contract explicit**

If Docker events expose second-based `time` values, normalize them once on the server and treat them as milliseconds in the client formatter:

```ts
function formatTime(time: number): string {
  const ms = time < 1_000_000_000_000 ? time * 1000 : time;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

- [ ] **Step 2: Verify the event page no longer renders 1970-era timestamps**

Use the browser harness to inspect the body text after loading `/events` and confirm there are no timestamps or page strings that indicate the old bug.

- [ ] **Step 3: Keep the live stream behavior intact**

Do not regress snapshot loading, WebSocket reconnect, or the history mode toggle while fixing timestamps or text parsing.

- [ ] **Step 4: Re-run the harness against the events page**

Run: `python scripts/regression-files-events.py`
Expected: event timestamps display as real dates and no body text is misclassified as a 404 error

### Task 4: Build and verify the finished regression set

**Files:**
- No new source files unless a failing test or harness gap forces it

**Interfaces:**
- Consumes: fixed files/events implementation and the browser regression harness
- Produces: build-verified changes and a concise result summary

- [ ] **Step 1: Run the project builds**

Run:

```powershell
cd web; npm run build
cd ..\server; npm run build
```

Expected: both builds succeed

- [ ] **Step 2: Run the browser regression harness again**

Run: `python scripts/regression-files-events.py`
Expected: clean output for both `/files` and `/events`

- [ ] **Step 3: Inspect git status before handoff**

Run: `git status --short`
Expected: only intended source and plan changes remain

- [ ] **Step 4: Commit and push if the user asks for delivery**

```powershell
git add -A
git commit -m "Reinforce files and events regression coverage"
git push
```

**Self-review checklist:**
- The harness covers both target pages.
- Any timestamp contract is explicit in one place.
- No placeholder steps remain.
- The plan stays focused on files and events instead of expanding into unrelated modules.
