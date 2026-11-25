# QA functional report (production build)

Tester: QA agent 1. Scope: functional/behavioural testing of the PRODUCTION build (`npm run build && next start`) with Chromium + Playwright at 375x812 (plus 812x375 and 900x700 spot checks). No app source was edited. Scratch scripts and fixtures live in
`/tmp/claude-0/-home-user-Main-chat/8c0f9322-8acb-5fb5-bd40-10249832903a/scratchpad/qa1/` (`fx/*.musicxml` are the tricky fixtures, `gen.js` regenerates them).

## 0. Result summary

| Area | Result |
|---|---|
| `npx vitest run` | 48/48 pass |
| `npx playwright test --trace off` (dev server) | 9/9 pass |
| Same e2e suite against the PRODUCTION server (`next start -p 3100`) | 9/9 pass |
| `npm run build` | passes |
| Prod: MusicXML / .mxl open, play, pause, prev/next, keyboard, tap-seek, BPM live, instrument switch (playing/paused), play-to-end, reload persistence, delete | work (issues below) |
| Prod: PDF rasterisation via pdfjs worker | works (2-page fixture -> 2 JPEGs, request built correctly) |
| Sync drift (audio clock vs cursor/bar), 60/100/180 BPM, 32 bars | PASS, see section 3 |
| Transposition (11 fixtures x 5 source x 5 target = 275 combos): pitch = concert + interval (+ octave k), clef, key | PASS, no pitch mismatches, no wrong clefs |
| MIDI export (22 fixture/tempo combos + 4 in-browser downloads) | PASS: note counts, tempo, programs, pitches, time sigs all correct |
| `/api/omr` | works; 2 minor validation defects (P2) |
| Console errors / unhandled rejections | none in any flow except expected 404 favicon, expected 503 no-key, aborted soundfont fetch on switch/navigation |

Findings: **0 P0, 5 P1, 11 P2**. (P0 = crash / wrong music: none found in the sounding pitches or timeline; the nearest are P1-1 and P1-2, which affect what the user sees/hears relative to the printed score.)

NOT TESTED (not possible here): real Claude OMR (no key), Audiveris over HTTP, real iPhone/Safari audio unlock and `capture` camera input, Firefox/Safari behaviour of Space-on-focused-button.

---

## 1. Findings

### P1 (broken feature)

**P1-1. Repeats: cursor freezes after the first repeat jump; audio ignores repeats too.**
- Repro: open `fx/repeats.musicxml` (bars: |: 1 | 2 | volta1 3 :| volta2 4 | 5), set BPM 60, Play.
- Expected: cursor follows the music through all bars (and, ideally, audio takes the repeat - README says repeats are ignored in v1).
- Actual: cursor advances through bars 1-3 (12 positions) then stays frozen at the end of bar 3 while the bar counter goes 4, 5. Measured on a 5-bar score: 12 distinct cursor positions for 20 notes; cursor is 100-150 px outside the bar highlight in bars 4 and 5. Audio plays the written bars once, linearly (3 and 4 both play, no repeat).
- Suspected: `components/ScoreView.tsx` `collect()` breaks on the first non-increasing OSMD timestamp ("repeat jump"), so everything after the repeat has no cursor steps; `lib/timeline.ts` has no repeat expansion. Fix: either expand repeats/voltas in `buildTimeline` and walk OSMD steps with an unfolded map, or at minimum keep collecting steps by measure index (not by timestamp) so the cursor follows the linear timeline. Repeats are very common in band charts.

**P1-2. Current-bar highlight is mispositioned / nearly invisible on many bars.**
- Repro: `fx/timesig.musicxml`, 900px wide. Press Next bar to bar 6 (one whole note) as trumpet: the highlight is an ~8 px strip BELOW the staff (y 419-427) instead of covering the bar. Switch to Trombone, Next bar to bar 2: highlight sits ABOVE the staff over the ledger-line notes (y 274-310) while the staff/cursor is at y 310-342. Also `voices` (trumpet) bar 2 (whole-note chord): box 24 px tall vs cursor 32 px, shifted.
- Expected: the whole bar (staff height, bar width) is tinted (UX rule: "highlight current measure").
- Actual: the box is derived from the measures' content bounds, so its height depends on where the notes are.
- Suspected: `components/ScoreView.tsx` `measureBoxes()` uses `GraphicalMeasure.PositionAndShape` Border* (content extents). Use the staff-line/StaffLine bounds of the system (or the cursor element's top/bottom for the current system) for y/h and the measure bounds only for x/w. Also affects tap-to-seek hit-testing (it uses the same boxes, `dy*dy*4` weighting).

**P1-3. BPM change while playing silences any note that is currently sounding (held notes drop out).**
- Repro: `fx/voices.musicxml`, BPM 60, go to bar 2 (whole-note chord), Play, after 1.5 s press "+" once. Instrumented `AudioBufferSourceNode`: 3 voices started, +1 BPM -> 3 extra `stop()` calls and 0 new starts for the remainder of the bar. The chord goes silent until the next bar.
- Expected: tempo change keeps held notes sounding (or re-triggers them) - spec: "setBpm: live change keeps position".
- Suspected: `lib/player.ts` `setBpm()` -> `restartFrom(currentQ)` -> `stopSound()` kills all voices, and `restartFrom` only schedules events with `timeQ >= q`. Fix: also re-schedule the remaining tail of events that started before q (start at q, duration = rest), or rescale the already-scheduled lookahead instead of restarting. Also each change loses the 60 ms `lead` (rapid -/+ presses shift timing: 10 presses = ~0.6 s behind a band).
- Same mechanism: instrument switch while playing (see P2-4).

**P1-4. BPM number field cannot be typed into.**
- Repro: tap the BPM box, select all, type `9` then `0` (wanting 90). Result after `90` is **240**; after Backspace-clearing and typing `120` it is **240**; clearing the field snaps it back to the old value.
- Cause: `onChange` accepts only `n > 0` and clamps immediately (`9` -> 30, then `300` -> 240); the input is fully controlled so intermediate text is impossible. `+`/`-`/tap-tempo work. (Playwright `.fill('180')` hides this, which is why the e2e passes.)
- Suspected: `components/Transport.tsx` BPM `<input>`. Fix: keep a local string state, commit/clamp on blur or Enter.

**P1-5. Multi-page scans easily fail with "too large" and the app offers no automatic fix.**
- Repro: a 6-page PDF of noisy (photographic) scans, ~1700x2200 each (`scan6.pdf`, 8.4 MB) -> error "Those pages are too large to send. Try fewer pages or a smaller photo." after 1.4 s, no request sent. Pages are rasterised at 2000 px edge / JPEG q0.85 and the 3.8M-char total cap is simply enforced (`lib/omrClient.ts` `prepareFiles`: the "shrink if over" comment is not implemented; `total = 0;` is dead code). A single 12 MP photo is fine (1.86 MB request).
- Expected: iteratively lower quality/edge (e.g. q0.7, 1600 px) until under the budget, since the plan says "keep request < 4 MB".
- Also: that client-side error shows a **"Try free reader"** button which retries the same prepare step and fails identically (see P2-9).
- Not verified with real sheet-music scans (typically smaller than noise), so severity could be P2 for 1-3 page uploads.

### P2 (minor)

**P2-1. BPM is not persisted across reload.** Repro: set BPM 133 on a score, reload `/score/<id>`: BPM shows 100 and localStorage `bpm:<id>` was overwritten with 100. Cause: `app/score/[id]/page.tsx` effect `[bpm,id]` runs on mount with the default 100 and writes `bpm:<id>` BEFORE `getScore().then()` reads it back. ("Play as" does persist; it is only written on change.) Fix: only write after the stored value has been read, or write in the setter.

**P2-2. `/api/omr` with body `null` returns an empty 500** (TypeError "Cannot read properties of null (reading 'images')", logged server-side). Expected 400 JSON `{error, code:'bad_request'}`. `app/api/omr/route.ts`: guard `body` being non-object after `req.json()`.

**P2-3. `/api/omr` silently accepts an unknown `engine`** (`"bogus"`, `5`) and treats it as `auto` (returns the no-key 503). Spec: `engine?: 'auto'|'claude'|'audiveris'`; expected 400. Same file. Related inconsistency: the same "images too large" condition returns `code:'too_large'` when caught by Content-Length and `code:'bad_request'` (still 413) when caught after parsing.

**P2-4. Instrument switch while playing restarts the bar and then restarts again when samples arrive.** `setTimeline()` snaps position to the start of the current bar (`restartFrom(posQ)`), observed cursor jumping back to the bar start; then `load()` resolves (0.5-3 s later on a cold CDN fetch) and calls `restartFrom(currentQ())` again, cutting the sounding notes (same cut-off as P1-3) and losing another 60 ms. Rapid switching (6 selections in 0.7 s) ended consistently in the last selection, playing, correct label - no race found. `lib/player.ts` `setTimeline`/`load`. While the new samples load, the old instrument's sound continues and the status line says "Loading sounds..." (acceptable).

**P2-5. Empty `<measure>` (no notes, no rest) desyncs cursor from bar counter.** `fx/rests.musicxml` bar 4 is `<measure number="4"/>`: the timeline gives it a full bar from the time signature, OSMD gives it zero width/time, so for bar 4 the cursor draws in bar 5's notes (up to ~120 px outside highlight) and is ahead by a bar afterwards. Real-file case, and a likely OMR-output defect. `lib/timeline.ts` (empty-measure fallback) vs `ScoreView.collect()`. Rest-only measures with a duration (whole rest, `rest measure="yes"`) are fine. Suggest `validateMusicXml`/repair to insert a measure rest in empty measures.

**P2-6. Pickup (anacrusis) bar is labelled "Bar 1".** `fx/pickup.musicxml` (`number="0" implicit="yes"`): counter shows `Bar 1 / 6` for the pickup and bars are all one higher than the printed bar numbers (players say "bar 12", sheets show 12). Audio/cursor/timeline are correct (pickup length 1 quarter, 19/19 events, no drift). Cosmetic but confusing for reading along. Use the MusicXML `number` attribute for the label (or call the pickup "Pickup").

**P2-7. Auto-octave puts treble material far above the bass staff for trombone/baritone.** E.g. trumpet written C4-C5 -> trombone: sounding Bb3-Bb4, drawn as 1-3 ledger lines above the bass staff (every note above the staff). It complies with the plan ("max notes in range, then smallest shift") because the range tops at Bb4, but all notes being on ledger lines is hard to read. Suggest tie-breaking toward the range centre (k=-1) when several octave shifts keep every note in range. `lib/transpose.ts` `chooseOctave`.

**P2-8. Transposition re-spells double accidentals** (pitches identical, spelling changed): F##4 -> G4, Bbb4 -> A4 even for trumpet->trumpet identity. Fine musically; noted because the plan lists "double sharps" under edge cases. No wrong pitches in 275 combos x 11 fixtures (incl. key changes mid-piece, C#/Cb/E#/B#, tied notes, triplets, 6/8, 5/8, pickups, 2 voices, chords, 2 parts).

**P2-9. Misleading error actions.** "Try free reader" is offered for client-side errors that are not reader failures: unsupported file ("Unsupported file: garbage.txt"), pages-too-large. Also the raw xmldom text leaks into the UI for an empty .xml: `Reporting fatalError "missing root element" caused Error: XML parse error: missing root element` (`lib/musicxml.ts` `parseXml`/`Uploader`). Other bad files give clean messages (HTML root, no notes, score-timewise).

**P2-10. No favicon**: `GET /favicon.ico` 404 on every page load (logged as a console error twice per load). Add `app/icon.*`.

**P2-11. Landscape (812x375): the score area is almost invisible on load.** Header + two selects + status text fill ~265 px and the sticky transport takes 109 px (top 266 of 375), so the score is below the fold until the user scrolls; auto-scroll then keeps the cursor visible (40/40 samples at 240 BPM OK). Portrait 375 transport is 3 rows (~180 px) as the plan notes. Consider hiding the pickers/status behind a collapsible bar in landscape.

Minor/not-a-bug notes: Space on the focused Play button toggles exactly once in Chromium (handled), but the handler also swallows Space on a focused checkbox (Click/Count-in) so it plays instead of toggling; Firefox/Safari Space-on-button double-toggle not tested. Metronome/count-in in 6/8 click every eighth at the quarter-note BPM (design choice, undocumented). Missing rate limit on `/api/omr` (listed as a refinement target). Garbage-but-valid base64 data URLs (e.g. truncated PNG) pass validation and would be sent to the model (cannot be tested without a key).

---

## 2. Test details

### 2.1 Existing suites
- `npx vitest run`: 5 files, 48 tests passed.
- `npx playwright test --trace off`: 9/9 on dev; 9/9 again against `next start` on port 3100.
- `npm run build`: ok (routes: `/`, `/_not-found`, `/api/omr` dynamic, `/score/[id]` dynamic).

### 2.2 Production flows (port 3417, scripts `prod1.js flow.js flow2.js flow3.js flow4.js nav.js`)
- Open `.musicxml` and `.mxl` -> saved, navigates to `/score/<id>`, SVG drawn (467-860 ms incl. 150 bars), "Sound: Bb Trumpet samples" (MusyngKite CDN reachable).
- Play/pause: cursor moves, pause holds position; Prev/Next/ArrowLeft/ArrowRight clamp at bar 1 and last bar; Next x45 -> Bar 40/40; Play at last bar plays and ends.
- Tap-seek while paused and while playing jumps to the tapped bar; tapping the margin does not move it.
- BPM live change keeps position (bar before/after identical); see P1-3 for held notes, P1-4 for typing.
- Instrument switch while playing (trumpet -> trombone -> sousaphone -> mellophone, plus 6 rapid switches) keeps playing, audio keeps being scheduled (5 notes/1.5 s at 190 BPM); while paused keeps the bar. Clef/key follow the instrument.
- Play to end at 240 BPM: Play button returns, Bar 1; replay works. 150-bar score plays through all 150 bars with 600 distinct cursor positions.
- Reload: library persists (IndexedDB), score page reloads with "Play as" restored (BPM not: P2-1). Delete via confirm dialog removes it; the old URL shows "That score is not in your library on this device."
- Leaving the player mid-play stops audio (0 new buffers, AudioContext closed); Back creates a fresh Player, no errors.
- PDF (`tests/fixtures/sample-scan.pdf`): worker loads in production, 2 pages -> 2 JPEGs (86 KB each), request `{images:[2], engine:'auto'}`; unstubbed -> shown verbatim 503 no-key message; stubbed 200 -> saved and opened. Photo (PNG) -> same. Bad inputs: .txt, empty .xml, HTML-root .xml, no-notes MusicXML, score-timewise all give an error and stay on the home page.
- Downloads (trumpet/mellophone/sousaphone/trombone @133 BPM): `.mid` has 160/160 notes, tempo 133, programs 56/60/58/57, first pitch 58/58/46/58 (concert 58 with the auto-octave), `.musicxml` has correct clef (G/G/F/F), key fifths (0/-1/-2/-2) and `<transpose>` (-2 / -7 / none / none). "Written for" change re-derives (first MIDI pitch 58 -> 53 -> 60 for trumpet/mellophone/sousaphone sources) and persists in the library row.

### 2.3 Sync (section 3 of the brief)
Method: a 40-bar 4/4 score of quarter notes (`fx/sync40.musicxml`). The page was instrumented with an init script that records `AudioBufferSourceNode.start(when)` for every scheduled note (real soundfont engine) and, in a `requestAnimationFrame` loop, `AudioContext.currentTime` whenever the cursor position or "Bar N" text changes. Anchor = first note's scheduled time; expected beat k = anchor + k*60/bpm. Reported error = (time the cursor/bar changed - expected time) in beats; positive = cursor late.

| BPM | notes scheduled vs ideal grid (max err) | bar counter lateness (bars 2..32) | cursor step lateness (128 steps) | drift trend |
|---|---|---|---|---|
| 60 | 0.000 beats | 0.00 .. +0.04 | 0.00 .. +0.04 | none (0.03-0.04 at bar 2 and bar 32) |
| 100 | 0.000 | 0.00 .. +0.05 | 0.00 .. +0.07 | none |
| 180 | 0.000 | 0.00 .. +0.11 | 0.00 .. +0.11 | none (~38 ms, constant rAF/render latency) |

PASS (< 1 beat, no accumulation over 32 bars). Note this compares the display against the WebAudio clock, not against wall-clock; audio-clock vs wall-clock was not measured. Also checked on tricky fixtures: bar counter runs 1..N in order for every fixture with no skipped or repeated bars (exception: repeats, P1-1; empty measure, P2-5).

### 2.4 Tricky MusicXML (fixtures in `scratchpad/qa1/fx/`)
`tricky1` (dotted quarter, 8th triplet, tie across barlines incl. a stop+start chain, F##, F#, natural, Bbb, E#, B#, Cb), `timesig` (6/8 -> 3/4 -> 2/4 -> 5/8 -> 4/4), `keychange` (0 -> 2 -> none -> -3 -> 0), `pickup`, `voices` (two voices with `<backup>`, whole-note chord), `rests` (measure rest, whole rest, empty measure), `repeats` (forward/backward + voltas), `range` (very low/high, Bb key), `twoparts`, `long150` (150 bars), `sync40`.
- Timeline (checked by hand): ties merged (A 1q+2q = 3q, B 2q+1q = 3q), dotted = 1.5q, triplet eighths = 0.333q, 6/8 bar = 3q, 5/8 = 2.5q, pickup bar = 1q, chord/voices give simultaneous events, measure starts correct, events = source notes minus merged ties. Repeats are not expanded (documented).
- Render: all fixtures draw without error; ties, triplet bracket, time-sig and key changes, accidentals and clef swaps look right (screenshots checked: `shot_tricky1.png`, `shot_timesig.png`).
- Playback per fixture at 240 BPM (trumpet and trombone): runs to the end and resets to bar 1, no console errors. Cursor vs bar highlight alignment: OK for tricky1, keychange, twoparts, pickup (trumpet); problems listed in P1-1, P1-2, P2-5.
- Transposition over every source x target (275 combos x 11 fixtures): written pitch = sounding - instrument offset with a single consistent octave shift k per score for all notes (0 mismatches); every clef is G2 for trumpet/mellophone and F4 for baritone/trombone/sousaphone; key fifths are concert minus 2 (trumpet) / minus 1 (mellophone) / 0 (bass instruments), including through mid-piece key changes (trumpet source 0,2,-3,0 -> mellophone -1,1,-4,-1 -> trombone -2,0,-5,-2 for k=-1). Round trip trumpet -> concert -> trumpet keeps all pitches (spelling differs only for double accidentals, P2-8). Part `<transpose>` is set for trumpet (-1/-2) and mellophone (-4/-7) and absent for bass instruments.
- MIDI (`toMidi`, parsed back with `@tonejs/midi`): note counts equal timeline events for all 11 fixtures at 60 and 133 BPM, tempo correct (133 reads back as 133.0002), time-signature events at the right ticks for the 5-signature fixture, duration equals `totalQ*60/bpm`, 150-bar file 600 notes.

### 2.5 `/api/omr` (prod, no key)
| Request | Result |
|---|---|
| valid image, auto / claude / wrong engine | 503 `no_key` JSON |
| engine `audiveris` | 503 `no_audiveris` JSON |
| invalid JSON, empty body | 400 `bad_request` |
| body `null` | **500, empty body** (P2-2) |
| `[]`, `"x"`, `{}`, `images: []`, `images: "x"` | 400 "Send at least one image." |
| non-data-URL, `image/svg+xml` | 400 |
| 7 images | 400 "Too many pages (max 6)" |
| `engine: "bogus"` or `5` | treated as auto (P2-3) |
| 4.5 MB / 7 MB / 30 MB / chunked 7 MB body | 413 (3 distinct messages/codes, no crash, no memory problem) |
| 3.9 MB body (under cap) | reaches the no-key 503 |
| GET | 405; OPTIONS 204 |
No Claude call was attempted.

### 2.6 Console
Across all flows: only `favicon.ico` 404 (P2-10), the deliberate 503s, and `net::ERR_ABORTED` on an in-flight soundfont/RSC request when switching instrument or navigating away (not console errors). No `pageerror`/unhandled rejection in any flow.
