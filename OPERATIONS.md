# Operations

Existed By is a static site on GitHub Pages with no server, no database and no accounts. Files are fingerprinted in the visitor's browser; only a blinded 32-byte digest goes to the public OpenTimestamps calendars, and block headers come from two public block explorers. GitHub Actions deploys and checks it. Nothing needs a person.

- **Live:** https://theguysaccount.github.io/verifiedreality-video-provenance/
- **Repo:** https://github.com/theguysaccount/verifiedreality-video-provenance
- **Base URL setting:** repository variable `SITE_URL` (unset = the github.io URL above)

## Automated jobs

| Job | Workflow | When | What it does | How it fails safe |
|---|---|---|---|---|
| Deploy | `pages.yml` | every push to `main`; on demand; when the self-test finds the live site behind `main` | Unit tests (hashes vs Node crypto, proof format round-trips, merge rules, damaged-input refusals, links, stamping/upgrading/verifying against simulated calendars and explorers with real block headers), build tests, build, end-to-end run in headless Chrome against the build, deploy, wait until the commit is live, the end-to-end run against the live site, IndexNow | Any failed test stops before deploy; the last good site stays live. IndexNow never fails the run. |
| Weekly self-test | `selftest.yml` | Thursdays 08:43 UTC (plus a temporary line on 22–23 Nov 2026 to prove the trigger) | Unit tests; **services**: all three calendars accept a stamp (at least two must), a calendar still serves a finished Bitcoin path that verifies, both explorers answer; **sample**: completes the sample proof once Bitcoin has it and commits it; the end-to-end run on the **live** site (stamps a test file on the real calendars, opens its check link, compares a matching and a different copy, verifies a complete proof against Bitcoin, rejects a tampered proof, checks for console errors, requests to hosts outside the policy, and phone overflow); every page, file and cited link; **staleness**: redeploys when the live build is older than `main` | Read-only against the site, except committing the completed sample proof (tests run first). A failure opens or comments on one `ops-alert` issue (GitHub emails the owner); the next pass closes it. Cited sites that refuse robots or are down are warnings. Safe to re-run any time. |
| Keep-alive | `selftest.yml` → `scripts/keepalive.sh` | with every self-test | Re-enables the scheduled workflow; an empty `[skip ci]` commit after 45 quiet days | Without it GitHub disables the schedule after 60 days with no commits. |

**Schedules on this account fire late** (hours, sometimes skipped). Nothing depends on timing: every job is idempotent, and the staleness check catches missed deploys.

**After the first scheduled run passes, remove the temporary cron line** (`29 */4 22,23 11 *`) from `selftest.yml`.

## What to watch

- Open `ops-alert` issues and red runs.
- **Calendars.** The site stamps on `a.pool.opentimestamps.org`, `b.pool.opentimestamps.org` and `a.pool.eternitywall.com` (they allow browser requests), and completes proofs from `alice`/`bob.btc.calendar.opentimestamps.org`, `finney.calendar.eternitywall.com` and `btc.calendar.catallaxy.com`. If a calendar shuts down or changes address, update `STAMP_CALENDARS`/`UPGRADE_CALENDARS` in `site/assets/net.js` **and** `CONNECT` in `pipeline/build.py` (the build test checks they agree). `ots.btc.catallaxy.com` accepts stamps but sends no CORS header, so browsers can't use it.
- **Explorers.** Block headers come from `blockstream.info` and `mempool.space`. Either can be down; the page uses whichever answers and refuses when they disagree.
- **Browsers can't read "not ready yet".** Calendars answer pending upgrades with a 404 that has no CORS header, so a pending proof logs a blocked request in the browser console. Expected; the end-to-end test ignores exactly those.
- The proof format follows python-opentimestamps byte for byte. If OpenTimestamps adds a new operation, `ots.js` refuses proofs using it with a clear message until support is added.

## Run anything by hand

```bash
node --test tests/js/*.test.mjs && python3 -m unittest discover -s tests
python3 pipeline/build.py && node scripts/e2e.mjs
node scripts/e2e.mjs https://theguysaccount.github.io/verifiedreality-video-provenance/
node scripts/check_services.mjs
node scripts/complete_sample.mjs            # prints "changed" when the sample proof completes
python3 scripts/check_live.py https://theguysaccount.github.io/verifiedreality-video-provenance
node scripts/e2e.mjs --screens              # refresh docs/screens/
~/.local/bin/gh workflow run pages.yml -R theguysaccount/verifiedreality-video-provenance
~/.local/bin/gh workflow run selftest.yml -R theguysaccount/verifiedreality-video-provenance
```

## Keys Jack can turn later

### 1. Custom domain

Handled by the domain rollout session; this is what it needs. Candidates (RDAP, 22 Nov 2026): `existedby.com` and `existedby.org` are unregistered.

Steps for a domain `D` (apex):
1. DNS: `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`; `AAAA @` → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`; `CNAME www` → `theguysaccount.github.io`. (Subdomain: one `CNAME` → `theguysaccount.github.io`.)
2. `~/.local/bin/gh api -X PUT repos/theguysaccount/verifiedreality-video-provenance/pages -f cname=D`, wait for the certificate, then `~/.local/bin/gh api -X PUT repos/theguysaccount/verifiedreality-video-provenance/pages -F https_enforced=true`.
3. `~/.local/bin/gh variable set SITE_URL -R theguysaccount/verifiedreality-video-provenance --body https://D`, then `~/.local/bin/gh workflow run pages.yml -R theguysaccount/verifiedreality-video-provenance`. Canonicals, sitemap, robots.txt, share cards and check links follow `SITE_URL`.
4. Check links already shared keep working: github.io redirects to the domain with the `#…` part intact, and the proof is inside the link.
5. The "stamps in this browser" list is per address: stamps listed at the github.io URL won't show at the new domain. The proofs themselves are unaffected (and the page tells people to download them).

### 2. Money: a newsroom version

Pages is non-commercial; the tool stays free. Slot: a "For newsrooms" box on the home page, hidden until `NEWSROOM_URL` is set to an offer on other hosting (bulk stamping, an API, stamping at capture from newsroom systems, shared proof archives). `~/.local/bin/gh variable set NEWSROOM_URL -R theguysaccount/verifiedreality-video-provenance --body https://…` and redeploy. An API needs a server (Cloudflare Workers would do) and Stripe; none exists.

### 3. Analytics (activation metric)

Off by default. Activation = `event/stamp_done`; share loop = `event/check_open` (a check link opened) and `event/check_match`. Also `stamp_start`, `proof_download`, `link_copy`, `link_share`, `check_complete`, `check_nomatch`. Never file names or hashes. Set `GOATCOUNTER_URL` (`https://<code>.goatcounter.com/count`) and redeploy; the build adds that one origin to the security policy.

### 4. Search Console

Verify the domain once one is live and submit `/sitemap.xml`. IndexNow runs on every deploy; the account-root robots.txt lists this sitemap.

### 5. New guides (content routine)

A monthly Claude routine can add a guide: "In ~/code/verifiedreality-video-provenance, add one guide in site/pages/ (copy guide-reencode.html's front matter) answering a question journalists or creators search about proving when footage existed, that the existing guides don't cover. Cite only sources you opened; run the tests and `node scripts/e2e.mjs`; link it from guides.html and the home page; commit; push."
