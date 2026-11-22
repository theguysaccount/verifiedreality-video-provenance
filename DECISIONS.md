# Decisions

1. **Public name "Existed By", not "VerifiedReality".** A timestamp proves a file existed by a date; it doesn't verify reality. A brand that says "verified reality" overclaims by its name, which the brief's risk list forbids ("don't overclaim"). The repo keeps Jack's name.
2. **OpenTimestamps, not a custom chain or paid service.** Free, open, standard proof files verifiable without this site; calendars aggregate so stamping costs nothing; Bitcoin is the most durable anchor. Our own client code (format, network, verification) so nothing depends on a third-party library or CDN.
3. **Blinded digest only.** The page sends SHA-256(fingerprint ‖ 16 random bytes), as the official client does. Calendars learn nothing about the file.
4. **Exact hashes only; re-encoding explained, not papered over.** Perceptual hashes would match re-uploads but also cleverly edited copies, so they can't show a file is unchanged. Guides explain why re-uploads don't match and what a mismatch does and doesn't mean.
5. **Verification without a node, honestly described.** Headers from two explorers must agree, carry real proof of work above a difficulty floor, and match the proof's Merkle root. The page says whom you're trusting and links the node-based method.
6. **Only listed hosts are contacted.** A proof file can name any calendar; the page only contacts calendars on its list (enforced by CSP too), so a crafted proof can't make a visitor's browser call arbitrary servers.
7. **Sample made by us.** A 4-second canvas clip recorded with MediaRecorder, stamped with our own reference code; it completes itself through the weekly job. The official example proofs are used only at test time, not shipped.
8. **Creators and journalists together, no account.** The open question "creators or newsrooms first?" is settled by building the free tool for individuals and leaving the newsroom offer as a key.
