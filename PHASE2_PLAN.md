# Brass Reader — Phase 2 plan (practice features)

## STATUS
Phase: BUILD
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
