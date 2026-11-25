# Brass Reader — Feature D: Play along with the drums (approved)

Read docs/GROOVE_RESEARCH.md first. Published sources contain no Junkanoo transcriptions, so the user's own drummers are the source of truth.

## D1. Record your drum line (primary)
- On the Grooves screen, record 1–4 bars from the mic (MediaRecorder or AudioWorklet raw PCM). Show a count-in click and a level meter. Max 30 s.
- Tempo detection: `web-audio-beat-detector` (MIT). Overrides: tap tempo, bar count (1/2/4), and nudging the downbeat (drag a marker on the waveform).
- Onset slicing (spectral-flux onset detection, own code): cut the loop into hits, store each hit's position in beats, then re-trigger the hits on the WebAudio clock at any BPM. This keeps the real timbre with no time-stretch artifacts. For tiny tempo changes (±8%) it may simply use playbackRate on the whole loop.
- Quantize slider from 0 to 100% (0 = keep the human feel).
- Save grooves in IndexedDB (name, audio blob, slices, original BPM, bars, feel). Rename and delete. Export/import a groove file (.groove.json + audio) so a drummer can share it with the band.

## D2. Starter kit (backup)
- Synthesized in WebAudio. The research doc has the recipes:
  - lead goatskin drum and bass goatskin drum: pitch-enveloped sine plus noise
  - cowbells, high and low: detuned squares through a bandpass
  - whistle: sine plus vibrato
- 3 preset patterns from the research doc (A Pulse, B Interlock, C Call & Response). Label them clearly in the UI: "Starter pattern — not a traditional rhythm. Fix it by ear."
- Step-grid editor: 16 steps (straight) or 12 (triplet feel) per bar, 1–2 bars. One row per instrument. Tap toggles a step. Long-press sets an accent. Save as your own groove.

## D3. Mixing with the music
- Per score: choose a groove (or none), drums on/off, drums volume vs. horns, straight/triplet feel (starter kit only).
- The groove stays locked to the player's beat grid: it follows BPM changes, seeks, loops (feature A) and count-in, and starts on the downbeat of bar 1 (pickups handled).
- Drums are excluded from pitch check (C1) scoring and from the mute-my-part logic. Recording (C2) can include or exclude them.
- MIDI export: optional drum track (GM channel 10; map lead/bass drum → 47/36, cowbell → 56, whistle → 72).

## Tests
- Unit: onset detection on synthetic clicks, tempo detection on generated loops at 90/120/150 BPM, slice scheduling at a new BPM (hit times correct within 5 ms), step-grid serialization.
- e2e: Chromium fake mic with a generated WAV drum loop → record → detected BPM ±2 → plays under the score in sync. Also test the starter kit editor.

## Handoff Notes

### Build agent (D1, D2, D3 built; one commit each: "Brass Reader drums: D1 record your drum line / D2 starter kit / D3 ...")
Tests at the end: see the last line of this section. New dependency: `web-audio-beat-detector` 8.2.39 (MIT). Its dependencies are all MIT except `tslib` (0BSD): web-audio-beat-detector-broker/-worker, broker-factory, worker-factory, fast-unique-numbers, @babel/runtime. It runs the analysis in a blob Web Worker (production CSP already allows `worker-src blob:`).

File map
- `lib/grooveAnalysis.ts` (pure): FFT, spectral-flux `detectOnsets`, own `estimateTempo` (which beat length puts most onset weight on a grid), `foldTempo`, `bpmFromTaps`, `guessBars`, `buildSlices` (hits in beats + audio ranges), `encodeWav`.
- `lib/grooveAnalyze.ts` (browser): `analyzeRecording` = onsets + tempo (web-audio-beat-detector `guess`, folded to ~70-175; own estimate if the library throws or finds nothing) + first guess of the downbeat (first hit just after the count-in) and bar count.
- `lib/groove.ts` (pure): `Groove` type, the starter kit (`KitPattern`, steps 0 rest/1 soft/2 on/3 accent, `STARTERS` A/B/C from docs/GROOVE_RESEARCH.md, `STARTER_LABEL`), pattern text serialization (`serializePattern`/`parsePattern`/`resizePattern`), `quantizeBeat`, `stepBeat` (16 straight / 12 triplets / swung sixteenths), `grooveBarHits`, `buildDrumEvents(timeline, groove, feel)` (the whole score's hits in quarter notes, pickups handled), `playbackRateFor`, groove file make/parse (`.groove.json` with the WAV embedded as base64).
- `lib/drums.ts`: `DrumBus` (own gain channel; `hit()` plays a kit sound or one slice of the recording at a context time; `stop()` cuts everything; `log` of recent hits is exposed as `window.__brDrumLog` by the Player's bus only, for tests) and the kit synthesis `playKit` (goatskin bass/lead = pitch-enveloped sine + slap noise, cowbells = two squares + bandpass + rattle, whistle = sine + vibrato).
- `lib/player.ts`: `Player.drums` (DrumBus), `setDrums(hits, source)`, `setDrumsEnabled`, `setDrumsVolume`. Hits are scheduled in `scheduleUntil` next to the notes (same `timeOf(q)`), so they follow tempo changes, seeks, loop passes (pointer reset in `wrapLoop`) and the count-in (no hits before bar 1). `stopSound` cuts them.
- `lib/drumSettings.ts`: per-score settings (`SavedScore.drums`: grooveId, on, volume, feel, inTakes, inMidi), `drumsAudible`, `feelFor`.
- `lib/grooveStore.ts`: IndexedDB `groove:<id>` records (the Groove plus its WAV `audio` Blob). `lib/pcmRecorder.ts` + `public/pcm-recorder-worklet.js`: raw PCM mic recording (AudioWorklet, ScriptProcessor fallback), level meter, 30 s cap.
- `lib/midi.ts`: `toMidi(..., drums?)` adds a "Drums" track on channel 10 (lead 47, bass 36, cowbells 56, whistle 72; recorded hits all 38).
- UI: `components/DrumsPanel.tsx` (Drums section of the Practice drawer: groove, on/off, volume, feel, "keep drums while recording/in take replays", MIDI drum track, "Grooves…"), `GrooveStudio.tsx` (full-screen list: starters, your grooves, play/edit/rename/export/delete/import), `GrooveRecorder.tsx` (recorder with count-in and meter; review with waveform, tempo, tap tempo, bars 1/2/4, quantize, snap-to, hear the loop, save), `Waveform.tsx` (draggable downbeat marker that snaps to a hit), `KitEditor.tsx` (step grid), `useGroovePreview.ts`. `RecordPanel` got an `onBusy` prop.
- Tests: unit `groove.test.ts`, `drums.test.ts`, `drumSettings.test.ts`, drum block at the end of `player.test.ts`, generator `tests/drumLoop.ts`; e2e `groove-record.spec.ts` (fake mic playing a generated 112 BPM drum WAV: record, tempo within 2 BPM, nudge/drag downbeat, save, reload, rename, export, import, delete, mic blocked), `groove-kit.spec.ts` (starter label, copy, step grid tap/long-press, 12 steps, 2 bars, save, edit), `drums-play.spec.ts` (starter and recorded grooves under the score: on the beat grid within 20 ms, after tempo change, bar jump, loop passes exactly 8 quarters apart; none/off; triplet; mute-my-part leaves the drums; MIDI channel 10).

Deviations and decisions
- The recording is stored whole (WAV, up to 30 s) with its onsets and downbeat, not trimmed, so a saved groove can be re-opened and its tempo, bars and downbeat changed. The groove file is ONE `.groove.json` with the WAV embedded (base64), not two files.
- Bar count (1/2/4) is chosen after recording (guessed from the length); the count-in click tempo is its own field (default: the score tempo).
- Recorded hits at another tempo: re-triggered on the grid; within +-8% of the recorded tempo the hits are also sped up/slowed with playbackRate, otherwise they play at their natural speed. Each hit is cut when the next one starts.
- Triplet feel of a 16-step starter pattern = swung sixteenths (2nd and 4th sixteenth of a beat move to 1/3 and 5/6); 12-step patterns are always triplets. The score's feel choice only applies to 16-step starter-kit grooves. For recorded grooves "Snap to" (sixteenths/triplets) sets the quantize grid.
- Grooves assume 4-quarter bars. A 3/4 bar plays the first three beats of a groove bar and the groove restarts every bar; 6/4 and 12/8 take two groove bars; a pickup bar plays the END of the groove's last bar so bar 2 starts the groove. Repeats and endings keep the groove counting.
- "Recording (C2) can include or exclude them" is read as: a setting that keeps or drops the drums while recording is armed and while a take is replayed with the backing. (The microphone can only exclude drums by headphones.)
- Starters are built in (`starter-a/b/c`), not stored; "Edit a copy" saves your own groove (without the starter label).
- Changing groove/feel while playing continues from the first hit not yet scheduled (no restart); already scheduled hits (up to 0.25 s) still sound.
- `NumField` got an optional `decimal` prop (tempo with one decimal).

NOT TESTED
- Real drummers: the e2e "drummers" are a synthetic kick/snare/hat loop through Chromium's fake mic. Tempo detection and onset slicing on real goatskin drums, cowbells and whistles in a loud room, phone-mic distortion, octave errors (80 vs 160 BPM) and a wrong downbeat guess are unmeasured. The own `estimateTempo` is only used when the library throws or finds nothing; the two were never compared on real audio.
- How the synthesized kit SOUNDS (nobody has listened) and whether the three starter patterns are close to anything real: they are hypotheses from docs/GROOVE_RESEARCH.md. The brass player's drummers must judge both.
- iOS Safari: AudioWorklet/ScriptProcessor recording, getUserMedia, the blob worker of the beat detector, long-press on a touch screen (tested with a held mouse button), the full-screen studio on small phones and in landscape.
- The production CSP: e2e runs on the dev server, which sends no CSP; `worker-src blob:` and `script-src 'self'` should allow the beat detector worker and `/pcm-recorder-worklet.js` but this was not run against `next start`.
- Sync on real devices: the drums use the same clock as the notes, but Bluetooth latency, playbackRate within +-8% and slices played against real tone were not heard. The "on the grid" e2e checks the scheduled audio-clock times, not what comes out of a speaker.
- Replaying a take with the backing while the drums are on/off (`inTakes`) is only covered by `drumsAudible` unit tests. Pickup bars and 3/4, 6/8 scores are covered by unit tests of `buildDrumEvents`, not by e2e.
- Storage: very large imports, quota errors, many grooves; groove files from a different app version.
- MIDI: recorded grooves export every hit as GM note 38 (no kick/snare classification).

Final run: 351 vitest unit tests, 73 Playwright e2e tests (63 earlier + 10 new; Chromium 375x812), `npm run build` passes.

### Refine pass
The recording analysis, the slicing and playback of recorded hits, the kit sounds and the step editor were reworked after this was written: see "Phase 2 Refinement Log" in PHASE2_PLAN.md (sections 1, 2 and 4). In short: `detectOnsets` returns `starts` and `levels` too, `estimateTempo` takes options (`hint`, `near`, `levels`, `from`) and is the primary tempo source, slices carry a lead-in (`Slice.pre`) and cross-fade, `playbackRateFor` eases instead of snapping, the kit is rendered by `lib/kitSynth.ts`, and `useGroovePreview` loops until stopped.
