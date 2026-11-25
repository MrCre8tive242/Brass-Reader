# QA, phase 2 + drums, production build (`npm run build && npm start -p 3300`)

Tester: QA agent (Playwright 1.65 / Chromium, 375x812, fake mic via `--use-file-for-fake-audio-capture`). No source edited, nothing committed.
Scripts: `/tmp/claude-0/-home-user-Main-chat/8c0f9322-8acb-5fb5-bd40-10249832903a/scratchpad/qa3/` (`h.js` harness, `t1`..`t17`).

## Summary
- P0: none. P1: none. P2: 6 (below). No console errors, page errors or request failures in any flow; the only CSP report is item 1.
- Regressions: vitest 351/351 pass (20 files). Playwright e2e 73/73 pass on the dev server (`npm run e2e`) AND 73/73 pass against the production server on :3300 (same specs, temp config pointing at 3300, removed afterwards). `next build` passes.

## 1. Production CSP / Permissions-Policy: everything allowed
Headers on `/`: `Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=()`; CSP as in next.config.ts. Observed with `securitypolicyviolation` listeners + console capture in every flow:
- beat-detector blob worker: starts (a `blob:` Worker appears), tempo found, "Detected 112 BPM" from the 112 BPM fake drummers. OK.
- `/pcm-recorder-worklet.js`: HTTP 200, `application/javascript`; `AudioWorklet.addModule` resolved ("ok"), so the real worklet is used, not the ScriptProcessor fallback. OK.
- Mic: getUserMedia works under `microphone=(self)`; pitch check, take recorder and groove recorder all got a live track and released it (readyState ended) on stop / leaving the page.
- MediaRecorder takes: record, save, download (`1a45dfa3` webm), replay "You alone" and "You + backing". OK.
- OSMD render (4-bar to 150-bar), soundfont (`gleitz.github.io/.../trumpet-ogg.js` 200, 1.9 MB, "Sound: Bb Trumpet samples"). OK.
- 30 s cap on the groove recorder: auto-stops at 30.5 s, reviewed, saved.

### P2-1. One `script-src eval` CSP violation on every page load (home, score, studio)
Repro: open any page on the prod build with a `securitypolicyviolation` listener. Report: `script-src eval http://localhost:3300/_next/static/chunks/0-hln_pmcgx6j.js` (chunk name changes per build). Expected: none. Actual: one per page load. Cause is a bundled dependency feature-probe (`Function("return function*() {}")()` inside try/catch, plus the core-js style `Function(...)` setImmediate/bind helpers) in the shared client chunk; it is caught, nothing breaks, nothing reaches the console. It would show up in any CSP report-uri. Do NOT add `'unsafe-eval'`. Suspected: a transitive dep in the shared chunk (OSMD / vexflow bundle). Low value to fix; just know it is expected noise.

## 2. Feature interactions (prod)
| Case | Result |
| --- | --- |
| Loop 1-2 + Starter B drums + speed trainer 160->220 (+20/pass) | Pass 1..4 labels step correctly, bar counter stays in {1,2}, drum hit q stays in [0, 7.75] across wraps, no errors. OK |
| BPM typed mid-loop with trainer on | Takes effect, trainer continues from the new BPM ("Pass 5 . 100 -> 220"). OK |
| Instrument switch (trumpet <-> trombone) while looping | Keeps playing, stays in the loop, pass label continues. OK |
| Seek (Next bar, tap on score) during the count-in | Moves to the bar, count-in not restarted, plays on. OK |
| Pitch check while drums play | 4/4 green, 100 %; drums keep playing (64 hits), my part muted at the player only. OK |
| Recording with "Drums while recording" on / off | On: 26 hits scheduled; off: 0 hits. Both takes saved. OK |
| Take replay "You + backing" while a loop is set | Replays within the loop; pass label counts. OK |
| Pitch check ON + record armed, then stop pitch check mid-recording | Shared mic stream stays live, recording continues, take saved. OK |
| Ensemble (qa-twoparts): mute my part + drums + loop | Drums keep playing (23 hits in 1.5 s), MIDI has tracks A, B and "Drums" on channel 10 (index 9). OK |
| Octave move then fingerings (bar 2 at C7-C7, loop bar 2, drop twice) | Out-of-range count 4 -> 2 -> 0, labels switch from dashes to real valves, survive reload, "Undo octave moves" restores. OK |
| Repeats + loop (qa-repeats, loops 1-2, 2-3, 1-5, 4-5) | Loops cycle through the unfolded order correctly, pass counter increments. OK |
| Pickup bar score + drums | Pickup bar plays the END of the groove bar; bar 1 starts the groove at q=1 and every bar restarts it. OK |
| 6/8, 3/4, 2/4, 5/8 (qa-timesig) + drums | Groove restarts every bar at the right quarter (q 0, 3, 6, 9...), bars of 3/2/2.5 quarters. OK (by design the groove is cut at the bar end) |

### P2-2. Next bar / Previous bar silently leaves the loop
Repro: loop bars 1-2, Play, press "Next bar" twice (or tap bar 3). Expected: either stay inside the loop or the loop visibly stays "armed". Actual: plays bars 3, 4, then stops at the end and jumps back to bar 1; the loop shading stays on, but the loop is never re-entered. Suspected: `Player.seek` with a loop set, `lib/player.ts` (loop only wraps at its own end, it does not pull the cursor in). Minor UX.

### P2-3. Microphone stays live while paused with the pitch check on, with no indicator outside the drawer
Repro: Practice > Pitch check > Start, close the drawer, Pause. The track stays `live` and a 30 ms polling interval keeps running until the check is stopped or the page is left (verified: leaving the page releases everything, and 5 min of looping shows no growth). Expected: a visible "mic on" mark on the main screen (the browser's own tab icon is the only hint). Suspected: `components/PracticeSheet.tsx` / `PitchPanel.tsx` (stays mounted by design). Privacy-flavoured UX only.

### P2-4. Practice drawer in landscape (812x375) is cramped
Repro: rotate to landscape, open Practice > Drums. The fixed transport covers the bottom of the sheet, leaving about 170 px of scrolling window; the Groove select is half hidden behind the transport. Usable by scrolling, but poor. Suspected: `.sheet` bottom offset vs `.transport` height in the global CSS. (Portrait and desktop 1280x800 are fine. The recorder screen is fine in landscape.)

### P2-5. Garbage groove audio: preview gives no message
Repro: import a `.groove.json` whose `audio.base64` is not audio (test file in the scratchpad `bad.groove.json`), tap Play in the Grooves list. Expected: an error line. Actual: nothing visible (only the earlier "Added ..." line). Using it on a score shows the right message ("The recording of this groove could not be opened, so it is silent.") and does not crash. Names are rendered as text (an `<img onerror>` name stays inert). Suspected: `GrooveStudio.togglePreview` / `useGroovePreview.ts`.

### P2-6. Loop number fields can be filled in a surprising order by fast input
Observation, not a user-reachable bug as far as I could tell: setting "from 3" then "to 4" in one automated burst ended as 3-34 (draft values race with the re-render that clamps the other field, `NumField` draft reset on `value` change). With Enter/blur between fields it behaves (3-4, 6-8). While a loop is active, typing a "to" smaller than "from" drags "from" down to it (5-5) instead of refusing. Suspected: `components/LoopPanel.tsx` set(), `NumField.tsx`.

## 3. Regressions / basic flows
- vitest: `Test Files 20 passed (20), Tests 351 passed (351)`, 2.9 s.
- e2e dev: `73 passed (2.9m)`. e2e prod (:3300): `73 passed (4.1m)`, single worker.
- Basic flows (open MusicXML, play/pause/seek, transpose, instrument change, MIDI and MusicXML download) are covered by `player.spec`, `upload.spec`, `band.spec`, `fixes.spec` and all pass on prod; I also drove MusicXML upload of qa-twoparts, MIDI download (3 tracks with drums) and zoom (loop shading re-aligns with the bars after A+ and after landscape rotation).

## 4. Performance (prod, headless Chromium, shared CPU)
150-bar score (`longScore(150)`), fingerings on (600 labels), range marks on, Starter C drums on, pitch check on (live marks), loop bars 1-4 at 240 BPM for 5 minutes (76 passes):
- Load to ready 1.5 s; fingerings on in 138 ms.
- JS heap after forced GC: 23.3 MB at start, 22.5 MB at 5 min (no growth; fluctuated 22.5-24.2). DOM nodes constant at 5009. Marks constant at 16. `__brDrumLog` stays 300-390 (it is capped). One AudioContext only.
- 56.7 fps (rAF) while looping with pitch check and drums.
- Timers: 2 intervals while playing with the pitch check (30 ms poll + transport), 1 while paused with the check on, 0 after closing the drawer with the check off, and 0 intervals, 0 live mic tracks, 0 running AudioContexts and 0 rAF callbacks 3 s after "Back to library". Leaving mid-recording saved the partial take and released the mic; reload mid-take released the mic and left nothing armed. No leak found.

## 5. Persistence (IndexedDB `keyval-store`)
- Keys seen: `score:<id>`, `groove:<id>` (Groove + WAV Blob, 714 KB for ~8 s; a 30 s recording is about 2.6 MB), `take:<scoreId>:<id>` (Blob).
- `SavedScore.drums` = `{grooveId,on,volume,inTakes,inMidi}`; loop, trainer enabled, groove choice all survive reload (loop marks 2, trainer checked, groove still "Mine"). Reload while playing stops playback and leaves the saved loop, trainer and groove intact.
- Takes cap: 12 takes recorded, 10 stored, 10 listed (newest kept). Deleting the score removed all its takes and kept the groove (grooves are global).
- Groove export: `Mine.groove.json` (`format,version,groove,audio`, 0.95 MB for 8 s); delete (two-step "Delete it?") then import restores it (new id); a wrong-format file shows "This is not a Brass Reader groove file."; a kit file with a bad pattern shows "The pattern in this file is damaged."; a damaged recorded file imports but is silent with a clear message when used.
- Not exercised: quota-exceeded writes, a groove file from a newer app version beyond `version: 9` (accepted, no version gate), Safari/iOS.

## NOT TESTED (needs real hardware, unchanged from the handoff notes)
Real mics, real drums and real brass tone, Bluetooth latency, how the synthesized kit sounds, iOS Safari (worklet, long-press, MediaRecorder m4a), alignment of "You + backing" against real audio, a brass teacher check of the fingering alternates (sousaphone chart for a trumpet-written part printed the same valve labels as the trumpet; worth a look).
