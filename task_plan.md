# Task Plan: Hub (Image Center) Regression — Local Mock Search Source

## Goal
Provide a usable image-search endpoint for the `/hub` regression when the test network cannot reach Docker Hub / mirror sources, so the search success path is actually exercised.

## Phases
- [x] Phase 1: Research public search sources + design local mock
- [x] Phase 2: Implement local mock Docker Hub search service
- [x] Phase 3: Configure mock as custom search source and run regression
- [x] Phase 4: Verify /hub regression success path + build
- [x] Phase 5: Check working tree / build

## Key Questions
1. Is there a reachable public Docker Hub search endpoint in this network?
2. Can a local mock reproduce the Docker Hub search protocol to drive the success path?

## Decisions Made
- Measured public candidates (dytt.online, lispy.org, 666860.xyz, hub.rat.dev, docker-0.unsee.tech, docker.1ms.run):
  all unreachable (DNS/403/404/timeout) or returning non-array results → no public source is usable here.
- Therefore implement a local mock search service (scripts/mock-hub-search.js) on 127.0.0.1:9530 that
  implements both registry (/v2/search?term=) and web (/v2/search/repositories/?query=) protocols with
  a legal { results: [...] } shape matching searchHubRepos()/toHubResult().
- Configure via POST /api/hub/search-source to point the custom search source at the mock.
- The regression script already accepts both success and graceful-degradation outcomes, so it stays robust.

## Errors Encountered
- Earlier "skeleton stuck" observations were an artifact of the script triggering a second concurrent
  search; fixed by observing only the first auto-search, which shows correct graceful degradation.
- Confirmed 502 root cause is upstream unreachable (env), not code.

## Status
**Completed** - mock search source verified; /hub regression now runs the search-success path (2 results,
zero network/console errors) with the mock configured, and still passes gracefully-degradation otherwise.
