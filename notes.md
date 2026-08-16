# Notes: Hub Regression Searching Sources

## Available public search sources (verified in this network)

Two public search sources return valid Docker Hub `results` arrays and are exercised by
`npm run regression:hub` (both yield repoCount=20, zero network/console errors):

1. `https://docker-0.unsee.tech` — direct reachable, standalone domain, verified OK.
2. `https://docker.tbap.top` — discovered via 308 redirect from `docker.tbedu.top` (edu mirror).

Both serve the standard web search protocol `GET /v2/search/repositories/?query=` and return
`{ count, results:[{repo_name, short_description, star_count, pull_count, is_official}] }`
matching server searchHubRepos()/toHubResult().

## Measured but unusable candidates (current network)
- docker.m.daocloud.io → 401 (auth required; pull-only, no search interface)
- docker.1ms.run → 404; docker.jiaxin.site/proxy.vvvv.ee → 400 (pull-only)
- docker.hpcloud.cloud / dockerproxy.link → 200 but text/html (not JSON, arr=False)
- docker.xuanyuan.me → 429 (rate-limited free tier)
- docker.1panel.live / hub.xdark.top / xdark.top / dockerproxy.net / docker.ckyl.me → timeout
- docker-0.unsee.tech basic /v2/search?term= sometimes times out; use /v2/search/repositories/?query= path
- Many others: DNS fail (jobcher, baidubce, 163, ixdev, registry.cyou, melikeme, sunzishaokao)
- hub.docker.com direct → timeout

## Notes on reliability
- These community sources can throttle/change anytime; recommend keeping multiple + local mock
  (scripts/mock-hub-search.js) as fallback. The regression script accepts success OR graceful
  degradation, so it stays robust whichever path runs.

## Setup (done at runtime, not in git)
POST /api/hub/search-source { host: "https://docker-0.unsee.tech" }

