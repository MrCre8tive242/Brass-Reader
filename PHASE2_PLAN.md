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
- Feature D (drums) not built.
