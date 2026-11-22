# Product: Existed By

**User.** Journalists, creators, researchers, activists and anyone who records footage that might later be disputed or faked.

**Painful job.** "Prove this footage existed before the deepfake / before the dispute." Today that means trusting a platform's upload date, which is editable, lost on re-upload, and controlled by someone else.

**Promise.** Drop a video; get a proof anchored in Bitcoin that this exact file existed by now. The video never leaves your device. Anyone can check it later, here or with the official OpenTimestamps client.

**Wedge.** The check link travels with the footage. Everyone who opens one meets the tool; search brings people asking "how to prove a video is original" and "why doesn't the re-uploaded video match".

**Why now.** Generated video is now convincing; the value of being able to show *order* (the original came first) is rising, and C2PA adoption is slow.

**Activation metric.** A completed stamp (`stamp_done`). Share loop: `check_open`.

**First revenue event.** A newsroom pays for bulk/API stamping or stamping at capture (other hosting; `NEWSROOM_URL` slot).

**v1 deliberately won't:** upload files; claim truth or authorship; use perceptual hashes (they can match edited copies); run a native capture app; sign C2PA manifests.
