# Brass Reader — Phase 2 plan (practice features)

## STATUS
Phase: BUILD DONE (A, B, C1, C2, C3, E built; D not built)
Next: QA
Order: build (Sonnet) → QA (Sonnet) → fix (Sonnet) → refine (Fable, high)
Drum groove (feature D) is waiting on research: docs/GROOVE_RESEARCH.md. Don't build it in this pass.

## Features to build in this pass
### A. Loop + speed trainer
- Pick a loop range: long-press or drag across bars on the score, or use "Loop bars [from]–[to]" in the transport. A shaded overlay shows the range.
- The loop plays seamlessly, with no gap at the wrap. The cursor follows it. Count-in happens only before the first pass.
- Speed trainer is optional: start BPM, target BPM, +N BPM every M passes (defaults 5 and 1). Show "Pass 3 · 85 → 120 BPM".
- Save the loop and trainer settings per score in the library record.

### B. Ensemble: whole section
- A "song" can hold several parts, one per instrument sheet. Add them by scanning more sheets into an existing song, or by importing a multi-part MusicXML (parts already supported).
- Align parts by measure number. If bar counts differ, warn and pad with rests.
- Mixer: per part play/mute/solo plus volume. "Mute my part" is one tap, and "my part" = the part chosen in the picker. Each part plays with its own instrument sound.
- Score view shows "my part" only. A toggle shows the full score, stacked staves, with OSMD rendering all parts.
- MIDI export: one track per part. MusicXML export: the multi-part score.
- Library schema migration: keep old single-part records working.

### C1. Pitch check (mic)
- getUserMedia mic. Pitch detection in an AudioWorklet or analyser loop, using the `pitchy` library (MIT, McLeod method) or equivalent.
- Compare against the expected SOUNDING pitch at the current position, with latency compensation. Mark each note green (within ±25 cents), yellow (25–50 cents, sharp/flat arrow) or red (wrong note / missed) on the score.
- Summary after a run: % notes correct and bars with most misses (tap to loop them; ties into A).
- Works with headphones best. Show a tip. When the backing plays through the speaker, suppress the user's own part's audio and use only notes the user should play.
- Permission denied or unsupported: show a clear message.

### C2. Record yourself
- Record mic (MediaRecorder) during playback, aligned to the playback start time.
- Playback modes: you alone, you + backing, original only. Save takes in IndexedDB per score (cap 10, delete). Download a take as .webm/.m4a.

### C3. Fingering / slide chart
- Toggle "Show fingerings". Under each note show valve combos for trumpet/mellophone/baritone (3-valve; baritone non-compensating 3-valve standard chart) and sousaphone (3-valve, BBb), and slide positions 1–7 for trombone. Use standard charts; choose the most common fingering, with alternates on tap.
- Implementation: OSMD lyric-like text below notes or an SVG overlay positioned from note bounding boxes.
- Written vs concert: lookup uses the WRITTEN pitch for trumpet/mellophone, and concert pitch for the bass-clef instruments.
- Out-of-chart notes show "—".

### E. Range warnings
- Highlight written notes outside the instrument's comfortable range (ranges in lib/instruments.ts). Offer "drop passage 8vb/8va" for a selected loop range.

## Rules
- Keep the existing stack. New deps allowed: `pitchy`. Anything else must be small, MIT/BSD, and logged.
- Don't break existing features or tests. Add unit tests (pure logic: loop scheduling, trainer steps, fingering lookup, part alignment, pitch scoring) and e2e tests (mic via Chromium fake media: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, with `--use-file-for-fake-audio-capture` using a generated WAV of the expected notes, to test pitch check for real).
- Mobile-first: new controls live in a "Practice" sheet/drawer, not more transport rows.
- Commit per feature with trailers (see BUILD_PLAN rules). Don't push. Log deviations in the Handoff Notes below.

## Handoff Notes

### Build agent (A, B, C1, C2, C3, E; D skipped)
Tests at the end: 313 vitest unit tests, 63 Playwright e2e tests (Chromium, 375x812), `npm run build` passes. One commit per feature ("Brass Reader phase 2: ..."). New dependency: `pitchy` 4.1.0 (MIT) only.

Where things live
- Practice drawer: `components/PracticeSheet.tsx` (stays mounted when closed so the pitch check and recorder keep running), opened by the loop icon in the top bar (aria-label "Practice"). Sections: Band, Range, Fingerings, Pitch check, Record yourself, Loop and speed trainer. Transport is unchanged except a "Pass n · bpm → target BPM" line above it while a loop is set.
- A: `lib/loop.ts` (+ `Player.setLoop/setTrainer/onPass`). The wrap re-anchors the audio clock at the exact loop end (no gap), cuts notes at the loop end, count-in only before pass 1, tempo steps at the wrap. Loop is picked by long-press (touch; a second long-press stretches it) or drag (mouse) on the score, or by typing bars. `SavedScore.loop`, `SavedScore.trainer`.
- B: `lib/song.ts` (parts, fitBars, mergeScores, mergeTimelines), `lib/mixer.ts`, `components/BandPanel.tsx`. `SavedScore.parts` (single-part MusicXML + instrument per part), `myPart`, `mix`. Old records are split on the fly from `sourceXml` (nothing migrates in storage until a part is added or a part setting is changed). `TimelineEvent.part` tags notes; `Player.loadParts/setMix`, each part has its own sound; `toMidi(..., tracks)` writes one track per part; MusicXML download is the merged multi-part score. "Add a part" opens `/?addTo=<id>` (scan or MusicXML file joins the song).
- C1: `lib/pitch.ts` (judging, PitchRun, summary), `lib/pitchMic.ts` (getUserMedia + pitchy on an AnalyserNode, 4096 samples, polled every 30 ms), `lib/micSession.ts` (one shared mic for pitch check and recorder), `components/PitchPanel.tsx`. `Permissions-Policy` now allows `microphone=(self)` (it was `()`).
- C2: `lib/takes.ts` (IndexedDB keys `take:<scoreId>:<id>`, cap 10, `deleteScore` also deletes takes), `components/RecordPanel.tsx`.
- C3: `lib/fingering.ts` (chart computed from each instrument's open harmonics: a note is played from the nearest open harmonic above it, 0-6 semitones; trombone positions = drop + 1; alternates are the other harmonics plus "3" for "1-2").
- E: `lib/range.ts`; octave moves are saved per score/part/instrument as `SavedScore.octaveShifts` and applied on top of the transposed part (undoable), never written into `sourceXml`.
- ScoreView: new props `marks` (colour notes: green/yellow/red/range), `labels` (text under notes, tap steps through alternates), `loop`, `onLoopSelect`. Notes are found by `noteKey(bar, offset in bar)`; the key map is built lazily on first use after each redraw.

Deviations and decisions
- Part picker semantics changed for multi-part files: a part is "my part" (shown alone, the others play along with their own instrument sound). "All parts together" in the picker now means "show the full score (stacked staves)"; my part stays the last chosen one. Old multi-part records without a saved part still open stacked, as before. A newly imported multi-part file opens on its first part.
- Parts are lined up by bar position, not by the printed number; the player's own part decides bars, repeats and time. A shorter part is padded with rests (warning shown in the Band section), a longer one is cut (warning shown).
- While the pitch check is on, my own part is muted at the player (not saved to the mix), so the speaker plays only the other parts and the click.
- Pitch detection uses an analyser loop, not an AudioWorklet. Latency compensation = output latency + base latency + microphone latency (+ half the analysis window); there is no manual calibration control. A note is green within 25 cents, yellow within 50 (arrow up = sharp, down = flat), red beyond or when fewer than 3 clear frames were heard. An octave error counts as a wrong note.
- Recording starts when Play is pressed (count-in included) and stops at Pause/end. "You + backing" replays the score from the bar where the take started at the tempo it was made at, and starts the audio `offsetS` (microphone latency) in, so the two line up approximately.
- The existing e2e test `fixes.spec.ts` "portrait 375" selectors were scoped to `.transport` (the practice drawer now also contains `.chk` labels). Test helper `openScore`/`openPractice` moved to `tests/e2e/helpers.ts`.
- Mic e2e files are split (`pitch.spec.ts`, `pitch-wrong.spec.ts`, `pitch-sharp.spec.ts`, `record.spec.ts`) because Playwright only allows `launchOptions` per file; each has its own generated WAV (`tests/e2e/audio.ts`).

NOT TESTED
- Real microphones, real speakers/headphones, real instruments: the e2e microphone is Chromium's fake device playing a steady generated tone. Pitch detection on real brass tone (octave errors, noisy rooms, low sousaphone notes with a phone microphone) is unmeasured; latency compensation is a guess for real devices (Bluetooth especially).
- Alignment of "You + backing" playback against a real recording (only that it starts and stops).
- `saveTake` pruning to 10 against a real IndexedDB (only the pure `takesToDelete` is unit tested); takes with Safari's audio/mp4 recorder (m4a) were not run.
- iOS Safari: long-press loop selection, getUserMedia, MediaRecorder, the drawer on small screens. Landscape layout of the drawer.
- Fingering charts: checked against the standard Bb trumpet chart and trombone positions by the unit tests written from the same rules; a brass teacher should look at the alternates (they are mechanical: other open harmonics within 6 semitones, plus 3 for 1-2) and at baritone/sousaphone low notes.
- Loop plus repeats/endings (loop follows the first time each bar is played); loop on multi-part scores with different repeat structures per part.
- Long scores with marks/fingerings switched on (the 160-bar performance test runs with both off).
- Feature D (drums): built afterwards, see DRUMS_PLAN.md Handoff Notes.

## Fix pass 2 (QA_PHASE2_UX.md and QA_PHASE2_PROD.md)

Fixed
- Keyboard: Space only plays when focus is not on a button, summary, link, `[role=button]` etc.; arrows and Space do nothing behind the Grooves studio. (`app/score/[id]/page.tsx`)
- Real dialogs: `components/useModal.ts` (focus in, Tab trap, Escape, `inert` page behind, focus returns to the opener, modal stack so the studio can open over the drawer). Used by `PracticeSheet` (the transport stays in the Tab loop and usable) and `GrooveStudio` (Escape in a sub-view goes back to the list). `aria-modal`, `aria-controls` on the Practice button.
- Practice drawer: Loop section first and open, section chips under the title (they open and scroll to a section), "Practice" shown on the top-bar button (icon dropped under 400 px), slimmer header, the score can scroll above the bottom sheet (`--sheet-h`) and the cursor is brought into view when it opens. On short landscape screens it is a full-height side panel (54 vw, 300-520 px) above the transport; on narrow landscape (568x320) the transport's second row hides while it is open.
- Clipping and touch: `.chk.wide` wraps, shorter drums copy, every `.btn.sm`, link button, "No sound?" summary and chip is 48x48 or more; step cells are at least 48 px (a whole beat per line on a narrow phone, 8 per line when it fits). New e2e audits check 320 and 390 px (drawer with every section open, studio list, step editor).
- Step editor: beat numbers on the first step of each beat, a "A tap makes a step: Soft / Normal / Accent" brush (touch way to a soft step) that doubles as the legend, stronger empty cells (visible in the light theme), sticky Tempo / Hear the pattern bar.
- Recorder: "1 Record, 2 Check tempo, 3 Save" step header and section headings, plain wording ("Tighten the timing", "Snap hits to"), sticky Hear the loop / Save / Discard bar, Discard asks twice, clearer first paragraph. "Your grooves" is listed before the starters once there is one.
- Groove export: `navigator.share({files})` where `canShare` allows it, otherwise a download; a notice names the file. Groove preview of a missing or garbled recording shows an error on that row.
- Loop: first-use tip under the pickers (gone after the first loop), a ring fills while a bar is held (cancelled when the finger moves), a short vibration and a toast when the loop starts, a "Loop bars a-b / Exit loop" chip above the score, and a dashed, hatched, labelled blue frame instead of a tinted bar that looked like the cursor. Next/Previous bar or a tap outside the loop exits the loop and says so in a toast. After a speed-trainer run the player's own tempo comes back when the music stops.
- Mic: a "Mic on" light above the transport whenever the microphone is open (`MicSession.subscribe`); the pitch check keeps its setting but closes the microphone while paused with the drawer shut, and reopens it on Play or when the drawer opens. `PitchRun` now leaves notes that were over before listening began (late microphone, start mid-score, a seek forward) unjudged instead of red.
- Pitch readout shows the WRITTEN note for the instrument being played ("Hearing C5 +3"), with "(sounds Bb4)" in small text for transposing instruments.
- Music data: sousaphone chart and range extended to F4 (added the Bb3, D4 and F4 harmonics; F#3 to Bb3 now read 2-3, 1-2, 1, 2, 0). Valve alternates pruned to 3 for 1-2 and trumpet/mellophone G5 = 0 or 1-3; the list and the reasoning are in a comment above `EXTRA_ALTERNATES` in `lib/fingering.ts`. Trombone alternates are unchanged. Side effect: `autoOctave` for a trumpet part on the sousaphone is now -1 (was -2) because the range is higher.

Not fixed (and why)
- PROD P2-1 CSP `eval` probe: harmless, `'unsafe-eval'` deliberately not added.
- PROD P2-6 loop number fields racing under automated fast input: the report says it is not reachable by a person with Enter/blur between fields.
- UX P2-11 contrast of `--muted` helper text in the light theme: measured about 5.9:1 on the panel colour, left as is.
- A half-height "peek" drawer, a moving playhead in the step editor, a per-note text alternative for pitch-check colours, and an accessible name for the loop frame on the score were suggestions, not in the fix list, and were not built.
- Not tested: real iOS Safari (share sheet, vibration, long-press), screen readers, real microphones (the mic light and the late-opening microphone were tested with Chromium's fake device only).

Tests after this pass: 354 vitest unit tests, 95 Playwright e2e tests (all pass; one drums timing test, `drums-play` "a starter pattern ... bar jump", failed once under load in a full run and passed 3 of 3 alone and on the full rerun), `npm run build` passes. New specs: `dialogs.spec.ts`, `loop-feedback.spec.ts`, `mic-light.spec.ts`, `groove-polish.spec.ts`. Two commits: sousaphone/alternates, then everything else (the UI changes share `page.tsx` and `globals.css`, so they were not split further).
