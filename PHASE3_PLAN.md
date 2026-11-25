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

### File map
V1 (2-bar view)
- `lib/barWindow.ts`: which two WRITTEN bars to show for a position in the PLAY order (`windowAt`, `windowOfSlot`, `nextSlotOf`, `prevSlotOf`; a practice loop wraps to its first bar; the last bar is shown alone) and `buildWindowXml` (a MusicXML of just those bars with the clef/key/time/transpose in effect there; unmatched ties/slurs and spanning marks removed).
- `lib/windowRender.ts`: draws a window with OSMD (one OSMD per pane, `drawWindow`) as large as the room allows and reports where bars, cursor stops, note heads and the lowest ink are (`measureLayout`). Narrow screens: bars one under the other (`stack`), wide: both on one line.
- `lib/fingerStyle.ts`: styles (numbers / dots / both / off, default both), `fingerMark` (data for one note), `layoutFinger` (shapes: dots, number, slide icon for trombone, a faint cell), `fitFingerSize`.
- `lib/windowOverlay.ts`: fingerings (one row under the lowest ink of each line, centred on the note heads) and printed bar names for a drawn window. Shared by the screen (SVG) and the video (canvas).
- `components/TwoBarView.tsx`: the view. A pool of 3 panes (current, next, previous) so the next bars are drawn before they are needed (no flicker); own moving line and bar highlight; tap = seek, long press = loop; pitch-check/range colours, loop shading, flagged bars.
- `components/FingerStylePicker.tsx`, `app/score/[id]/page.tsx` (view toggle + style under the score; mode saved per score as `SavedScore.view`; style in localStorage `brass-reader:finger-style`), `app/globals.css`.

V2 (video)
- `lib/videoPlan.ts`: pure parts: sizes, frame k -> time/position/bar pair (`framePos`), length, file name, size estimate.
- `lib/voices.ts`: `SynthVoice` and `createVoice` moved out of `lib/player.ts` so the offline render uses the same sounds.
- `lib/videoAudio.ts`: the sound made in an `OfflineAudioContext` (same parts, mix gains, note lengths and drum bus as the player).
- `lib/videoRender.ts`: `FrameDrawer` (OSMD -> SVG -> picture per bar pair / per page, everything that moves is drawn on a 2D canvas), `makeVideo` (WebCodecs + muxers, or real-time recording).
- `components/VideoDialog.tsx`, `components/Downloads.tsx` (the button), page wiring.
- Tests: `tests/unit/barWindow.test.ts`, `fingerStyle.test.ts`, `videoPlan.test.ts`; `tests/e2e/twobar.spec.ts`, `tests/e2e/video.spec.ts`; fixture `tests/fixtures/phase3-demo.musicxml`.

### New dependencies (all MIT)
- `mp4-muxer` 5.2.2, MIT.
- `webm-muxer` 5.1.4, MIT.

### How the video is made
1. Sound: always rendered OFFLINE (`OfflineAudioContext`, 48 kHz stereo), much faster than real time. Horns and band parts as set (saved mix, not the temporary pitch-check mute), drums only if a groove is chosen and ticked. No click or count-in. Falls back to the synth if the soundfont cannot load.
2. Pictures: the notation of each bar pair (or each page of lines for "Full sheet") is drawn once by OSMD into a hidden element, turned into an image, and every frame is drawn from the timeline on a canvas (30 fps): header with title/instrument/BPM/bar, bar highlight, moving line, fingerings, progress line.
3. File: if the browser can encode H.264 + AAC with WebCodecs: MP4 via `mp4-muxer`, faster than real time. Else if it can encode VP9 (or VP8) + Opus: WebM via `webm-muxer`, also faster than real time (this is what Chromium here does: a 9 s video in about 3.5 s). Else: the sound is played in real time while the frames are drawn into `canvas.captureStream()` + `MediaRecorder` (MP4 where `isTypeSupported`, else WebM); the dialog says "recorded in real time" and the file is as long as the song. A short tail (1 s) is added. File name `<title> - <instrument> - <bpm>bpm.<ext>`.
4. Progress bar and Cancel in the dialog. Estimated size shown; a warning appears above 200 MB. The file is held in memory (ArrayBuffer target).

### Decisions and deviations
- The 2-bar view always shows MY part (not the "all parts together" stack).
- Portrait / narrow: the two bars are stacked one under the other (each as wide as the screen) when they do not fit side by side; wide screens: one line. OSMD does not stretch a short line, so the zoom is found by drawing again until the closest notes have room for their fingerings. The A-/A+ zoom buttons do not change the 2-bar view (it always fits).
- Last bar: shown alone. A one-bar loop shows that bar twice. At the end of a loop the second bar shown is the loop's first.
- Tied-on notes and rests: no fingering. Notes outside the chart: a dash.
- Trombone: slide position number, with a small 7-position slide icon (not dots) in "Valve dots" and "Both". The dots button is called "Slide icon" for trombone.
- The fingering style is one setting shared by the 2-bar view and the video dialog (stored on the device, default Both). "Full sheet" keeps its own existing "Fingerings" checkbox in Practice (numbers, tap for alternates).
- Video: the "Full sheet" video shows pages of lines (as many lines as fit), and turns to the next page when the music reaches it.
- `lib/player.ts`: only moved `SynthVoice` and the soundfont loader into `lib/voices.ts`; behaviour unchanged.
- View switch placed UNDER the score (a row above it pushed the score down on a landscape phone and broke an existing test).

### NOT TESTED
- iPhone / Safari (WebCodecs `VideoEncoder`/`AudioEncoder`, `OfflineAudioContext` with the soundfont, `MediaRecorder` MP4, the Save button on iOS), real Android phones, real touch long-press on a device.
- The MP4 (H.264 + AAC) path itself: the Chromium used here cannot encode H.264/AAC, so only the WebM path and the real-time path ran. The MP4 branch uses the same code with `mp4-muxer`, codec strings `avc1.640032`... and `mp4a.40.2`.
- Memory on a phone for a 5-minute song (the offline sound is ~115 MB for 5 minutes, plus the file). Not tried on a real device; chunked rendering was not built.
- Soundfont samples in the video: in the sandbox the synth fallback may have been used if the CDN was unreachable.
- Dark mode of the 2-bar view (styles written, not looked at), very long scores (hundreds of bars) in the Full sheet video, multi-part scores with different parts in the video (only logic shared with the player).
- Recorded (not starter-kit) grooves in the video.

### Tests
- Unit (vitest): 448 passed (was 410; +38).
- e2e (Playwright, Chromium, `npm run e2e`): 122 passed (all existing ones plus 15 for the 2-bar view and 5 for the video).
- `npm run build` passes.
- Screenshots were looked at (375x812 and 844x390, scale 1, all four styles, trumpet and trombone, dense eighths, ledger lines, sparse bars); fixes made from them: bars now fill the width, bar names above the staff, stems/beams cleared by the fingering row, faint cells around dot groups so neighbours read apart, slide icon narrowed.
