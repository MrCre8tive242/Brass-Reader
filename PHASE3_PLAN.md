# Brass Reader — Phase 3 (approved): 2-bar view + video download

## V1. Two-bar view (in the app)
- On the score screen, a toggle: **Full sheet / 2 bars**. Remember the choice per score (SavedScore setting).
- 2 bars: show only the bar now playing and the next bar, drawn large (fit width, phone portrait and landscape).
  - When the player enters bar N+1, the view shows N+1 and N+2. Last bar: show it alone, or with the end.
  - Pickup bars, repeats/voltas (unrolled timeline), loops (feature A), seeks and back/forward all move the view correctly. Use the player's timeline, not the written bar numbers.
- The moving line and bar highlight work in the 2-bar view as in the full view.
- **Fingering under every note** for the selected instrument (lib/fingering.ts). Style setting: **Numbers** (e.g. 1-3) / **Valve dots** (3 circles, filled = pressed; mellophone/trumpet/baritone/sousaphone 3 valves; trombone shows slide position number instead of dots, with a small slide icon) / **Both**. Default: Both. Also the option **Off**.
- Rest = no fingering. Tied note = fingering only on the first note.
- Everything else keeps working: BPM, pause/back/forward, drums, ensemble, pitch check, record, range warnings.
- Implementation hint: OSMD can draw a measure range (`drawFromMeasureNumber` / `drawUpToMeasureNumber`) or render a separate OSMD instance per 2-bar window; pre-render windows ahead so the switch has no flicker. Fingerings can be an absolutely positioned layer using note x-positions from OSMD's graphic notes.

## V2. Download video
- Next to **Download MIDI**: **Download video**. Dialog: view (**2 bars** / **Full sheet**), orientation (**Portrait** default, 1080x1920 / **Landscape** 1920x1080), fingering style (same 4 options), include drums (follows the score's drums setting), BPM and instrument = the current ones.
- Video shows the notation with the moving line/bar highlight, fingerings, the title, the instrument and the bar number; audio = the same mix the player makes (horns + band parts as currently set + drums).
- Output **MP4 (H.264 + AAC)** via WebCodecs + a small MIT muxer (e.g. `mp4-muxer`), rendered faster than real time if possible (OfflineAudioContext for audio, frames drawn to a canvas from the timeline). Fallback: real-time capture with `canvas.captureStream()` + MediaRecorder (MP4 where supported, else WebM, and say so in the UI). Progress bar + Cancel. File name: `<title> - <instrument> - <bpm>bpm.mp4`.
- If audio cannot be rendered offline with the soundfont player, render the audio in real time once and the frames offline, or capture everything in real time — choose what works, document it.
- Memory: a 5-minute song must not crash a phone (stream chunks to the muxer; ArrayBuffer target ok up to ~200 MB, warn above).

## Tests
- Unit: window-of-bars from timeline position (pickups, repeats, loops, last bar), fingering style rendering data, video frame timing (frame k -> correct bar/cursor), filename.
- e2e (Chromium 375x812 and 844x390): toggle 2 bars, play, the view advances on the bar change, fingerings visible under notes in each style, seek/back/forward/loop; Download video produces a non-empty mp4/webm whose duration ≈ song length at the BPM (check with a quick parse of the file header or the muxer's reported duration).
- Keep all existing tests green; `npm run build` must pass.

## Handoff Notes
(build agent fills in: file map, decisions, NOT TESTED)
