# Existed By

**Prove a video existed by a date, without uploading it.** A free in-browser tool that fingerprints a file (SHA-256, computed on your device in a background thread, any size) and timestamps the fingerprint on Bitcoin through the public [OpenTimestamps](https://opentimestamps.org/) calendars. You get a standard `.ots` proof and a check link. Anyone can later verify the proof against Bitcoin and compare their copy of the file.

Live: https://theguysaccount.github.io/verifiedreality-video-provenance/

A timestamp proves that an exact file existed no later than a Bitcoin block's time. It doesn't prove that what the video shows is true, who made it, or where. The site says so on every page that shows a result.

## What's here

- `site/assets/hashes.js`: SHA-256 (incremental), SHA-1, RIPEMD-160 in plain JS.
- `site/assets/ots.js`: the OpenTimestamps proof format (read, write, merge, evaluate), byte-compatible with the reference client.
- `site/assets/net.js`: calendars (stamp, upgrade) and Bitcoin verification against block headers from two explorers, with a local proof-of-work check.
- `site/assets/stamp.js`, `hash-worker.js`: the stamp page. `check.js`: the check page. `proofs.js`: check links and the list of stamps kept in the browser.
- `site/pages/*.html`: page bodies with a JSON block on top. `pipeline/build.py`: builds `dist/` (Python stdlib).
- `site/data/sample-clip.webm` + `.ots`: a 4-second clip made by this project, and its proof.
- `scripts/e2e.mjs` + `cdp.mjs`: end-to-end test in headless Chrome against the real calendars. `check_services.mjs`: calendar and explorer health. `complete_sample.mjs`: completes the sample proof. `check_live.py`: live pages and staleness.

## Run, test, deploy

```bash
python3 pipeline/build.py && python3 -m http.server -d dist 8000   # http://127.0.0.1:8000/
node --test tests/js/*.test.mjs            # unit tests, no network (Node 22+)
python3 -m unittest discover -s tests      # build tests
node scripts/e2e.mjs                       # end-to-end against dist/ (Chrome + network)
node scripts/check_services.mjs            # are the calendars and explorers up?
```

Deploys run from GitHub Actions on every push to `main`. See [OPERATIONS.md](OPERATIONS.md) for scheduled jobs, what to watch, and the keys (custom domain, money, analytics).

## License

MIT. See [LICENSE](LICENSE). Proofs are standard OpenTimestamps files and open in the official client.
