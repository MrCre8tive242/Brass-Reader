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
(As first built. The Refinement Log at the end changes steps 1, 3 and 4: sound in pieces, more ways to an MP4, the file written in blocks.)
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
(As first built. See "Still NOT tested" in the Refinement Log for where this stands now.)
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

## Phase 3 Refinement Log

Refinement pass over V1 (2-bar view) and V2 (video), in the order it was asked for. Where this log and the Handoff Notes above disagree, this log is the newer one.

### Found on the way (bugs in what was handed over)
- **The video had almost no sound when the sample horns were loaded.** The sample player (`smplr`) keeps notes that lie more than 0.2 s ahead in a queue and hands them to the audio engine by a timer on the wall clock. An offline render does not wait for that timer, so only the first notes got in: a 17 s test video had 0.45 s of music and then silence. (The synth fallback was not affected, which is why it went unnoticed.) Offline renders now pass the sample player a scheduler that hands every note over at once (`createVoice(..., { offline: true })` in `lib/voices.ts`). Every video test now checks that each second of the result has sound.
- **Full-sheet video:** fingerings of other pages were drawn over the title (nothing was clipped to the page). The page is now clipped to its card, only the page's own fingerings are drawn, and the page is drawn a little larger when its lines do not fill the card.
- This Chromium can encode H.264 after all (it was thought not to): only AAC is missing. So H.264 in an MP4 is now exercised for real here (with Opus sound).

### 1. iPhone Safari export
- **Which file a browser gets** is decided in `lib/videoSupport.ts` (`chooseRoute`), from yes/no answers of the browser, in this order:
  1. H.264 + AAC in an MP4 through WebCodecs, faster than real time. (Current iPhones: Safari 26 has both encoders. Android Chrome. Desktop Chrome on Windows/macOS.) Several H.264 profile/level strings are tried (`avc1.640028` first: High, level 4.0, the lowest that holds 1080p30); AAC is tried at 48 kHz, then 44.1 kHz, and the sound is rendered at the rate that was accepted.
  2. Apple device without an AAC encoder (iPhones before iOS 26 have a VideoEncoder but no AudioEncoder at all): **real-time recording with MediaRecorder, which makes a proper MP4 (H.264 + AAC) on Safari.** As long as the song, but a file Photos and WhatsApp take. Preferred there over anything with Opus or WebM.
  3. H.264 + Opus in an MP4, faster than real time (Chrome/Chromium on Linux; an Apple device with neither AAC nor MediaRecorder MP4).
  4. WebM (VP9, then VP8, + Opus), faster than real time.
  5. Real-time recording: MP4 if `MediaRecorder` can, else WebM.
- No pure-JavaScript AAC encoder was added: none with an MIT/BSD/Apache licence and a maintained build was found, and writing PCM or ALAC into a .mov is not something WhatsApp can be trusted with.
- **The dialog asks first** (both shapes are probed when it opens) and says in plain words what the file will be and, for the real-time way, how long it takes. If only the other shape can be an MP4 it says so.
- **If the quick way breaks half-way** (an encoder error, e.g. a phone taking the hardware encoder away), the same frames and sound are recorded in real time instead, and the result says so.
- **User-gesture rules:** the real-time way needs a running `AudioContext`, which a phone only starts from a tap. It is created inside the "Make video" tap (always on iPhone/iPad, so it is also there for the fallback), before any `await`. Saving is a second, fresh tap on the finished screen: **Save to Photos or share** calls `navigator.share({ files: [File] })` straight from the click (iOS: "Save Video" puts it in Photos; WhatsApp and AirDrop are in the same sheet); **Download file** is a plain `<a download>` (Files app). On phones the share sheet is the big button, on computers the download is. A failed share says to use the download.
- Also: screen wake lock while it works; the real-time way stops with a clear message if the page is left (the recording would have a hole); the canvas is on the page while recording (a canvas off the page is not captured by every browser), which doubles as a live preview; a small player on the finished screen; the music player is paused when the dialog opens.
- The notation picture is loaded with `onload` first and `decode()` second (some browsers reject `decode()` for SVG pictures); `roundRect` has a fallback.

### 2. Memory for long songs
- **Sound in pieces** (`lib/videoAudio.ts`, `AudioRenderer`): the sound is rendered in 20 s pieces, each in its own `OfflineAudioContext`, handed to the encoder and dropped. Longest buffer: about 8 MB (20 s + lead-in, stereo, 48 kHz) instead of about 115 MB for a 5-minute song (and twice that on the old real-time path, which copied it).
  - Each piece starts early enough to hold every sound still ringing at its start, at least 1.5 s early (so the drum compressor and the limiter have settled), and on a whole audio block (128 frames): compressors work block by block, and only then is a piece sample-for-sample what one long render would give. Measured: pieces against one long render differ by less than 0.000002 of full scale, with sample horns, kit drums, recorded drums and three parts.
  - The kit drums' small random differences (which take, pitch and loudness nudges) are fixed for the whole song up front, so a hit sounds the same in whichever piece it is rendered.
  - Decoded samples are shared between the pieces (the context's `decodeAudioData` is given a memory), the sample file is read once, and **only the pitches the part plays are loaded** (a full instrument is about 88 notes, roughly 100 MB decoded; a part uses 10 to 25).
  - Kit drum sounds are computed once per sample rate, not once per piece.
  - The real-time way renders each piece while the one before it plays, and frees it after.
- **File in blocks** (`lib/videoMux.ts`, `lib/blobSink.ts`): the muxers write through a stream target in 1 MB blocks; each block becomes a `Blob` at once (browsers keep those outside the page's memory and may put them on disk) and the blocks are joined at the end. The MP4 index goes at the end of the file (like a camera file), so nothing has to be kept to write it first. Before: every encoded frame in memory plus one buffer of the whole file.
- At most 3 frames wait for the encoder (was 8).
- Measured in headless Chromium (software H.264 encoder, which lives in the page's process; an iPhone's hardware encoder does not), 5 minutes, 150 bars, trumpet and kit drums, 1080×1920: made in about 105 s; the page's process sat at 630 to 750 MB the whole time against 430 MB with the score just open, **flat from the first seconds to the last** (no growth with the length of the song). File: 17 MB (2 bars), 28 MB (full sheet).
- Video bit rate target lowered from 2.5 to 2 Mbit/s (the picture is mostly still; files come out far below the target).

### 3. 2-bar view
- Looked at 390×844 and 844×390, light and dark, deviceScaleFactor 1: trumpet, trombone (slide icon), sousaphone, dense eighths, ledger lines, ties, key changes. Notes are as large as the width (upright) or the height (sideways) allows; the dark look is readable (white notes on a brown highlight). No change to the drawing was needed.
- **A−/A+ are hidden in the 2-bar view**: the bars always fill the screen, so the buttons had nothing to do there.
- **One fingering style setting, also in Practice.** The Fingerings section of the Practice drawer has the same Numbers / Valve dots / Both / Off picker (same stored setting as under the bars and in the video dialog), and its header says the style in use. The full sheet now writes fingerings in that style too (dots or slide icon over the number; tapping still steps through the other ways to play a note, and the dots follow). The tick box there now only says whether the full sheet shows them ("Show fingerings on the full sheet too", off by default as before; greyed when the style is Off).
- Fingerings under the right note heads: unchanged (already tested note by note); the same check now also runs on the full sheet for dots.

### 4. Video look
- Looked at frames taken out of real files with ffmpeg: 2 bars and full sheet, 1080×1920 and 1920×1080, a 150-bar score, a 3-part score, with and without drums.
- Header: title, instrument · BPM, **"Bar 12 of 48"**. Count-in: **"1 2 3 4"** in the bar number's place, the beat being counted large and orange, the first bars waiting on screen with a faint highlight and no moving line.
- 2 bars, landscape: drawn larger (they filled 70% of the width before). Full sheet: page fitted to the card, clipped, bar number at the start of every line, rounded progress line.
- **Count-in bar** (new option, on by default): one bar of the player's count-in clicks before the music (before a pickup it counts up to the pickup). Without it nobody can come in with a play-along video.
- **Loudness:** the player's mix peaks far below full scale when few parts play (a trumpet alone: about −30 dB mean). The video's mix is turned up by an amount worked out from what is in it (up to 3×; nothing when the drums are in), with a limiter behind it that only works if that guess was too bold. The balance between parts and drums is the player's.
- A video with every part muted and no drums says "This video has no sound".
- Recorded grooves and band scores in the video's sound are now tested (the drums alone are rendered and measured; each part alone is).

### 5. Other
- Result screen: save buttons above the player (on a phone turned sideways the player pushed them off screen).
- "Make another" brings the choices back instead of making the same video again.
- **Only the looped bars** (shown when a practice loop is set, off by default): the video is of just the loop, as a small tune of its own (`sliceTimeline` in `lib/timeline.ts`): count-in, those bars once, the groove starting with them. The file is named `<title> bars 9-12 - <instrument> - <bpm>bpm.mp4`. For sending a section the hard bars at a slow tempo.
- If the horn samples could not be loaded (no signal, nothing saved) the video is made with the simple synth sound and the result says so.

### Dependencies
- None added. `mp4-muxer` 5.2.2 (MIT) and `webm-muxer` 5.1.4 (MIT) are used as before, now through their stream targets.

### Test hooks
- `window.__brVideo` (already there): now also the format words, the sample engine and the loudness of every second.
- With `window.__brTest` set before the page loads, the video dialog exposes `window.__brVideoLib` and `window.__brVideoJob` so a test can render the sound whole and in pieces and compare.

### Tests after this pass
- Unit (vitest, `npm test`): **491 passed** in 31 files (was 448). New: `videoSupport.test.ts` (which file each kind of browser gets, Apple detection, save buttons), `blobSink.test.ts`, `videoMux.test.ts` (MP4 and WebM written block by block; **real H.264 + AAC streams from ffmpeg put together by the app's writer and decoded by ffmpeg without a complaint**, skipped where ffmpeg is not installed), `videoAudio.test.ts` (pieces, lead-ins, block alignment, drum dice), count-in and frame timing in `videoPlan.test.ts`, `markOfText` in `fingerStyle.test.ts`, `sliceTimeline` in `timeline.test.ts`.
- e2e (Playwright, Chromium, `npm run e2e -- --trace off`): **142 passed** in 25 files (was 122).
  - `video.spec.ts` (16; there were 5): a video of only the looped bars, MP4 with H.264 really encoded (2 bars and full sheet; ffprobe: h264, 1080×1920, 30 fps, 300 pictures, sound 48 kHz stereo, decodes clean; sound in every second), landscape without count-in, WebM when H.264 is refused (decodes clean), shape tip, real-time recording, fallback to real time when the encoder breaks half-way, cancel, synth sound without a signal, silent video, pretended current iPhone (Safari's user agent and answers; MP4 route, sound context made in the tap, share sheet given the right file, download still there), pretended older iPhone (real-time MP4, one sound context made in the tap), failed share, pieces of sound against one long render with kit drums.
  - `video-groove.spec.ts` (2): a recorded groove (fake microphone) is in the video's sound, on every second, and pieces still join; a two-part score sounds each part.
  - `twobar.spec.ts` (+4), `fingering.spec.ts` (+3): hidden size buttons, the shared style picker in Practice, styles on the full sheet, tapping dots, trombone slide icon.
  - The video file is its own Playwright project, listed first, so its heavy encoding runs next to screen-only tests and is over before the microphone tests start (run next to them it made one of them miss notes). Running one file works as before.
- `npm run build` passes.
- Looked at (deviceScaleFactor 1): 2-bar view at 390×844 and 844×390 in light and dark (trumpet, trombone, sousaphone; three scores); full sheet with dots; Practice Fingerings section; the video dialog before, during and after at both sizes, light and dark, as a pretended iPhone; frames taken with ffmpeg from 2-bar and full-sheet videos in both shapes (count-in, middle, last page of a 150-bar score, a 3-part score).

### Still NOT tested
- **A real iPhone.** Everything about Safari is reasoned from its documented behaviour and pretended in Chromium: that Safari 26's `AudioEncoder` takes `mp4a.40.2` at 48 kHz stereo, that its H.264 encoder takes 1080×1920, that its encoded chunks go into the muxer as Chromium's do, how fast it is, that "Save Video" appears in the share sheet for this file, that Photos and WhatsApp take it, the wake lock, and the whole real-time MediaRecorder way on iOS 16 to 18 (canvas capture, MP4 output, staying in sync).
- **AAC made by a browser.** No encoder for it here: the AAC branch ran with real AAC only through the muxer (ffmpeg's frames), and in the browser with Opus standing in behind the AAC answers.
- **Memory on a phone.** The figures above are from desktop Chromium. The design keeps memory flat however long the song is, but the level on an iPhone (and its limit) is not measured.
- Real Android phones (whether their H.264 encoders take 1080×1920; the dialog falls back and says what to do), Firefox, desktop Safari.
- How the louder mix sounds on phone speakers; nobody has listened, only levels were measured (trumpet alone: −23 dB mean, peaks −5 dB, where it was −30 dB mean; three parts with kit drums: −15 dB mean, peaks −1.4 dB, as the player mixes it).
- Videos of scores with several hundred bars in the full-sheet view (150 bars tried) and very slow tempos (long real-time recordings).
- Touch gestures on a device (long press in the 2-bar view), as before.
