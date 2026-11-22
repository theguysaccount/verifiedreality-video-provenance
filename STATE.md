# State (2026-11-22)

- **Source material:** one line in Jack's notes (Nov 2022): "Blockchain for video to store it as proof of upload before the deepfakes come out." No code, design or domain existed.
- **What works:** v1 live on GitHub Pages. Stamp: hashes any file on-device (worker, ~290 MB/s), stamps a blinded digest on three OpenTimestamps calendars, returns a standard `.ots` and a check link, keeps a local list that completes itself. Check: opens links or `.ots` files (including the official client's), completes pending proofs from the calendars, verifies Bitcoin attestations against headers from two explorers with a local proof-of-work check, compares a copy of the file.
- **Verified against reality:** the official example proofs round-trip byte for byte; the 2015 and 2016 examples verify to the same blocks and dates as the official client; stamps are accepted by all three calendars.
- **Tests:** 13 JS unit tests, 7 build tests, a 9-step end-to-end run against the real calendars and explorers, on every deploy and weekly against the live site.
- **Not built (by design):** uploads, perceptual hashing, capture apps, C2PA signing, accounts.
- **Worth reusing:** `ots.js` + `net.js` (a dependency-free OpenTimestamps client for browsers), `hashes.js`.
