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
