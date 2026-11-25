# Brass Reader — BUILD_PLAN

## STATUS
Phase: DONE
Next model: none (build, QA, fix pass and refinement are done)
Last updated by: refine agent
Current step: Refinement DONE (see "Refinement Log" at the end). Next real-world step: set ANTHROPIC_API_KEY and try the reader on real charts (never run live so far). Step 5 (audiveris-server) is still owned by another agent.

## Goal
Mobile-first web app for a brass player (Junkanoo-style brass/drum group). Upload a photo or PDF of sheet music → app reads it into MusicXML → shows the score with a moving playback cursor + highlighted current bar → play/pause/prev bar/next bar/tap-bar-to-seek → set BPM → switch instrument (trumpet, mellophone, baritone, trombone, sousaphone), which changes BOTH the sound and the written part (transposition + clef) → download MIDI and MusicXML. Scans saved locally so you don't pay to rescan.

## Decisions (fixed — do not change)
- Web app, Next.js App Router + TypeScript, deploy to Vercel. Folder: `brass-reader/` (self-contained, own package.json).
- Reader (OMR): **Claude vision primary** (`/api/omr`, Anthropic SDK, model from env `OMR_MODEL`, default `claude-sonnet-5-5`; key from env `ANTHROPIC_API_KEY`). **Audiveris backup**: separate Docker service in `brass-reader/audiveris-server/`, used when env `AUDIVERIS_URL` is set and Claude fails or the user picks "Free reader". Vercel can't run Java, so Audiveris is deployed separately (later); the app must work without it.
- Also accept direct upload of `.musicxml`/`.xml`/`.mxl` (skips OMR).
- Instruments (written vs concert):
  | id | name | clef | written→concert semitones | GM program (0-based) | sample |
  |---|---|---|---|---|---|
  | trumpet | Bb Trumpet | treble | -2 | 56 | trumpet |
  | mellophone | Mellophone (F) | treble | -7 | 60 | french_horn |
  | baritone | Baritone (bass clef) | bass | 0 | 57 | trombone (fallback) |
  | trombone | Trombone | bass | 0 | 57 | trombone |
  | sousaphone | Sousaphone | bass | 0 (sounds as written) | 58 | tuba |
- Pipeline: source MusicXML (as read, written for `sourceInstrument`, default trumpet, user can change) → **concert-pitch canonical** → transposed for target instrument, with **auto-octave** so median pitch sits in the instrument's comfortable range (ranges: trumpet written F#3–C6, mellophone written F#3–C6, baritone/trombone concert E2–Bb4, sousaphone concert E1–F3; prefer octave shift that keeps max notes in range).
- Rendering: OpenSheetMusicDisplay (OSMD) with its built-in cursor = the "line going across"; also highlight current measure.
- Audio: `smplr` Soundfont instruments (MusicyBox/gleitz MIDI.js soundfonts via CDN) scheduled on WebAudio clock; cursor synced via requestAnimationFrame from audio time.
- MIDI export: `@tonejs/midi`. Tempo = chosen BPM. Program per instrument. Pitches = concert (sounding) pitch.
- Storage: IndexedDB via `idb-keyval` (library of saved scores: id, title, sourceXml, sourceInstrument, createdAt).
- Images sent to OMR are downscaled client-side (max 2000px long edge, JPEG q0.85). PDFs rasterized client-side with `pdfjs-dist` (max 6 pages). Keep request < 4MB (Vercel limit).

## Stack (pin exact versions present on npm at build time; use latest stable)
next, react, react-dom, typescript, opensheetmusicdisplay, smplr, @tonejs/midi, idb-keyval, pdfjs-dist, @anthropic-ai/sdk, fast-xml-parser (server XML validation), jszip (.mxl unzip). Dev: vitest, @playwright/test (use preinstalled Chromium — see env notes), @xmldom/xmldom (DOM in node tests).
Builder: load the `claude-api` skill before writing `/api/omr`.

## File tree
```
brass-reader/
  BUILD_PLAN.md            this file
  README.md                setup, env vars, deploy, Audiveris
  package.json / tsconfig.json / next.config.ts / vercel.json
  app/layout.tsx           shell, fonts, theme tokens, viewport
  app/page.tsx             Home: library list + "Scan music" + "Open MusicXML"
  app/score/[id]/page.tsx  Player screen for a saved score
  app/api/omr/route.ts     POST images → MusicXML (Claude, fallback Audiveris)
  app/globals.css
  components/Uploader.tsx  camera/file/PDF input, preview, page order, send
  components/ScoreView.tsx OSMD render + cursor + measure highlight + tap-to-seek
  components/Transport.tsx play/pause, prev/next bar, bar counter, BPM, metronome toggle, count-in toggle
  components/InstrumentPicker.tsx  "Written for" + "Play as" selects
  components/Downloads.tsx MIDI + MusicXML buttons
  lib/instruments.ts       table above + ranges
  lib/musicxml.ts          parse/serialize helpers, unzip .mxl, extract title, validate
  lib/transpose.ts         toConcert(), fromConcert(), autoOctave() on MusicXML (pitch step/alter/octave, key fifths, clef, <transpose>)
  lib/timeline.ts          buildTimeline(xml) → events (handles ties, dots, tuplets, rests, repeats ignored v1 → note in README)
  lib/player.ts            Player class: load(instrument), play(fromMeasure), pause(), seek(measure), setBpm(), onPosition cb
  lib/midi.ts              toMidi(timeline, bpm, program) → Uint8Array
  lib/omrClient.ts         prepare images (downscale, pdf→png) + call /api/omr
  lib/library.ts           idb-keyval CRUD
  lib/omrPrompt.ts         Claude system prompt + few-shot for MusicXML output
  audiveris-server/Dockerfile, server.py (POST /omr image→MusicXML via Audiveris CLI), README.md
  tests/unit/*.test.ts     vitest
  tests/e2e/*.spec.ts      playwright
  tests/fixtures/          sample .musicxml (simple scale, ties/dots, 2 pages, key changes), sample images rendered from them
```

## Interfaces
- `type InstrumentId = 'trumpet'|'mellophone'|'baritone'|'trombone'|'sousaphone'`
- `toConcert(xml: string, from: InstrumentId): string` · `fromConcert(concertXml: string, to: InstrumentId): string` (includes autoOctave) · `autoOctave(concertXml, to): number` (octave shift applied, -2..2)
- `buildTimeline(xml: string): { events: {timeQ: number /*quarter notes from start*/, durQ: number, midi: number /*sounding*/, measure: number}[], measureStartsQ: number[], totalQ: number, timeSigs: {measure:number, beats:number, beatType:number}[] }` — midi is SOUNDING pitch: apply the part's `<transpose>` if present.
- `toMidi(tl, bpm, program): Uint8Array`
- `Player`: `new Player(audioCtx)`, `await load(id: InstrumentId)`, `setTimeline(tl)`, `play(fromMeasure=current)`, `pause()`, `seek(measure)`, `setBpm(n)` (live change keeps position), `metronome: boolean`, `countIn: boolean` (1 bar), `onPosition((q, measure)=>void)`, `onEnd`.
- `POST /api/omr` body `{ images: string[] /*data URLs*/, engine?: 'auto'|'claude'|'audiveris' }` → `{ musicxml: string, engine: 'claude'|'audiveris', warnings: string[] }` or `{error}` with 4xx/5xx. Validates XML parses and has ≥1 `<note>`; Claude path retries once with the parse error.
- ScoreView syncs the OSMD cursor to the player's `q` (walk cursor by timestamp); tapping a measure calls `player.seek(m)`.

## UX rules
- Mobile-first (iPhone width 375), big touch targets (≥48px), dark stage-friendly theme with light mode, landscape works.
- Transport sticky at the bottom. Bar counter "Bar 12 / 48". BPM: number input + −/+ buttons + tap-tempo, range 30–240, default 100.
- Keyboard: Space play/pause, ←/→ bar.
- Auto-scroll the score to keep the cursor visible.
- Clear error states: no key configured → show "Add ANTHROPIC_API_KEY in Vercel" message; reader failed → offer "Try free reader" (if available) or "Open MusicXML instead".
- Disclaimer: "Reading is automatic. Check the notes against your sheet."

## Build steps
- [x] 1. Scaffold Next app, deps, vitest + playwright config, `lib/instruments.ts`, fixtures (hand-write 4 MusicXML fixtures). **Done when:** `npm run build` and `npx vitest run` pass (empty test ok).
- [x] 2. `lib/musicxml.ts`, `lib/transpose.ts` + unit tests (trumpet→concert→trombone lands in bass clef, correct key sig, octave in range; round-trip trumpet→concert→trumpet identical pitches). **Done when:** tests pass.
- [x] 3. `lib/timeline.ts` + `lib/midi.ts` + tests (ties merge, dotted, tuplets, multi-measure, time sig change; MIDI parses back with @tonejs/midi with correct note count/tempo). **Done when:** tests pass.
- [x] 4. `app/api/omr/route.ts`, `lib/omrPrompt.ts`, `lib/omrClient.ts`. Unit-test validation/retry logic with the SDK call injected (plumbing only). **Done when:** tests pass; route returns clear 503 JSON when no key.
- [ ] 5. `audiveris-server/` Dockerfile + server.py. Try installing Audiveris in this container (GitHub release or apt) and run it on a fixture image; record result in Handoff Notes. **Done when:** works locally, or blocker logged.
- [x] 6. `lib/player.ts` + `components/ScoreView.tsx` + `Transport.tsx` + `InstrumentPicker.tsx` + `Downloads.tsx` + pages + `lib/library.ts`. **Done when:** `npm run build` passes; in dev, opening a fixture plays, cursor moves, pause/seek/BPM/instrument switch work (verify with a Playwright smoke test).
- [x] 7. `components/Uploader.tsx` end to end (images + PDF + MusicXML upload → saved in library → opens player). **Done when:** e2e test uploading fixture .musicxml and a fixture PDF (OMR route stubbed only in this test) passes.
- [x] 8. README (setup, env vars, Vercel steps, Audiveris deploy), vercel.json. **Done when:** written.

## Test phase (agents after build)
- Unit + e2e full run; mobile viewport screenshots (375×812, landscape); check cursor sync drift < 1 beat over 32 bars at 60/100/180 BPM; instrument switch re-renders correct clef/key; MIDI opens and matches; accessibility basics; console errors = 0.
- Real OMR: Audiveris on fixture images if available. Claude live test only if `ANTHROPIC_API_KEY` exists in env — otherwise mark NOT TESTED (never fake).

## Refinement targets (Fable, high)
OMR prompt quality and validation/repair of model MusicXML; cursor/audio sync precision; transposition edge cases (accidentals, key changes, enharmonics); UI polish, stage-friendly design, mobile ergonomics; performance on long scores; security (upload size limits, rate limit on /api/omr, no key exposure).

## Rules for builders
Don't change stack, file tree or interfaces. If something is impossible, log it below and take the simplest working path. Commit after each step (`git add brass-reader && git commit`), on branch `ccr-4bbe3223-t2kgyf`. Do not push. No model names in commit messages or code comments other than the `OMR_MODEL` default.
Env notes: Chromium + Playwright are preinstalled — don't run `playwright install`; if the project pins @playwright/test, launch with `executablePath: '/opt/pw-browsers/chromium'`; pass `--trace off`.

## Handoff Notes
Build agent (steps 1,2,3,4,6,7,8; step 5 / audiveris-server left to another agent and not touched).
Tests: 48 vitest unit tests pass; 9 Playwright e2e tests pass (player.spec 3, upload.spec 6); `npm run build` passes.

Deviations / decisions:
- `<transpose>` is written into the displayed part for transposing instruments (trumpet, mellophone) and OSMD ignores it for display (verified). Auto-octave shifts both written and SOUNDING pitch (sousaphone plays trumpet music 2 octaves down); timeline reads sounding pitch from `<transpose>`.
- `toConcert` honours an existing `<transpose>` in the source file (and strips it) instead of the assumed "Written for" instrument.
- Written `<accidental>` elements are removed on transposed notes; OSMD recomputes accidentals (visually verified: sharp/natural appear correctly).
- autoOctave: maximise notes in range, tie-break smallest |shift|, then median closest to range centre.
- Player has an oscillator synth placeholder from construction, swapped for smplr Soundfont (MusyngKite) once loaded; load failure/timeout (12 s) keeps the synth. Samples did load from the CDN in this sandbox ("Sound: ... samples" shown).
- BPM change while playing re-anchors and re-schedules (notes already sounding are cut briefly). Count-in is one bar of clicks.
- Audiveris token env is `OMR_TOKEN` (matches audiveris-server/server.py), not AUDIVERIS_TOKEN.
- No `fallbacks`/refusal-fallback parameter on the Claude call (plan fixes model/env); a `refusal` stop reason is surfaced as an error and triggers the Audiveris fallback if configured.
- vitest config is `vitest.config.mts`; tsconfig `include` was auto-extended by Next.
- Score is drawn on a paper card; dark mode inverts the OSMD SVG with a CSS filter (cursor/bar highlight are unaffected siblings).

NOT TESTED:
- Real Claude OMR (no ANTHROPIC_API_KEY): only plumbing with the SDK call injected. `callClaude` in app/api/omr/route.ts (streaming, 64000 max_tokens, no thinking param) has never hit the API. The OMR prompt is unvalidated against real scans.
- Audiveris fallback over HTTP (only the request shape in route.ts, matched to server.py by reading it).
- Real iPhone camera `capture` input; landscape layout; cursor drift measurement; long scores.
- Tap-to-seek is only smoke tested (click far right of bar 2 changes the bar).
- Repeats are ignored; multi-part scores not tested in UI.

Files most needing review: lib/transpose.ts (spelling/key wrap edge cases), lib/player.ts (scheduling, count-in, restart on BPM change), components/ScoreView.tsx (OSMD cursor stepping, measure boxes, auto-scroll heuristics), app/api/omr/route.ts + lib/omrPrompt.ts (never run live), lib/omrClient.ts (pdfjs worker via `new URL(..., import.meta.url)` works in dev; production build compiles but only dev was exercised in e2e).
Known UI issue: transport takes 3 rows at 375px (Count-in checkbox wraps); consider compacting.

## Fix pass
Source: tests/QA_FUNCTIONAL.md and tests/QA_UX_MUSIC.md. One commit per item ("Brass Reader fix: ...").
Tests after the pass: 121 vitest unit tests, 29 Playwright e2e tests, `npm run build` passes.

Fixed
1. Repeats/endings: `lib/timeline.ts` `unrollMeasures()` unrolls forward/backward repeats (incl. `times`), voltas (`<ending>`), D.C./D.S. al Fine/Coda via `<sound dacapo|dalsegno|fine|tocoda|coda|segno>`. Timeline events keep `measure` = WRITTEN bar and `timeQ` = play-order time. Audio, cursor, click track, count-in and MIDI follow the unrolled order. Prev/Next bar step through played bars (`Player.stepBar`), tap-to-seek and `seek(m)` go to the FIRST pass (`firstQ`). ScoreView collects OSMD cursor steps per written bar/offset and positions by (measure, offset), so the cursor jumps back at a repeat.
2. Bar highlight: box y/height now come from the staff (all staves of the system plus ledger-line room), x/width from the bar; stronger fill + outline in dark and light. OSMD multi-bar-rest merging is switched off so every written bar stays drawn.
3. Held notes: restarts (BPM change, instrument swap while playing) re-attack notes sounding at the current position with their remaining length, without the 60 ms lead (no drift on rapid changes). Instrument switch with identical bar layout keeps the exact position.
4. BPM field: free typing with a draft string, clamp 30-240 on blur/Enter; persistence bug fixed (only user changes write localStorage).
5. Large PDFs/photos: `fitToBudget()` re-encodes through a quality/size ladder until under the request budget; "Try free reader" is only offered for genuine reader failures and only if `GET /api/omr` says Audiveris is configured. Empty-xml parse errors no longer leak xmldom wrapper text.
6. /api/omr: optional `APP_PASSCODE` (header `X-App-Passcode`, UI asks once, localStorage, clear wrong-passcode error), per-IP in-memory rate limit (default 10/10 min, `OMR_RATE_LIMIT`, `OMR_RATE_WINDOW_MIN`) with 429 + Retry-After, `max_tokens` 16000 (`OMR_MAX_TOKENS`), `stop_reason: max_tokens` -> 422 `too_long` (falls back to Audiveris if configured), SDK/Audiveris error text logged server-side and replaced by generic messages, 400 JSON for null/array/unknown engine, 415 for non-JSON content type, bounded streaming body read (header AND real size), consistent `too_large` code, system prompt cached. Documented in README.
7. "Written for": `detectSourceInstrument()` (transpose element, else clef: F/C -> trombone concert, G -> trumpet). Uploader default is "Detect from the music"; the player shows what was detected and why; user override persists.
8. Validation: `lib/repair.ts` `analyseAndRepair()` checks each bar against the time signature (first bar, last bar and implicit bars may be short). Empty bars and short single-voice bars are padded with rests; long/multi-voice bars are only flagged. Server: retry prompt names the failing bars and the cleaner reading wins; warnings go in the response. UI: "Check these bars against your sheet: Bar 7 may be misread (...)".
9. UX: 2-row transport at 375 (and 360/320) with Play centred and largest; landscape phone: slim one-row transport, compact header/pickers; zoom A-/A+ (persisted `brass-reader:zoom`); re-scroll to cursor after rotate/zoom; autoscroll uses the measured header/transport heights; focus rings on upload buttons; Space ignored on any input/select/textarea; light accent `#b05200` (5.2:1 with white); 48px targets (reorder buttons, checkboxes' labels, tap, zoom); `viewport-fit=cover` + safe-area padding; light/dark themeColor; `app/icon.svg` favicon; picker selects no longer overflow at 375.
10. OMR prompt rewritten: WRITTEN pitches exactly as printed, `<alter>` = effective alteration as written, clef/key/time exactly as printed (clef-octave-change, common/cut time), repeats/endings/D.S./coda encoded (not skipped), photo handling, ties vs slurs, grace notes, tuplets, pickup `implicit`, `<rest measure="yes"/>`, bar-sum self-check. The example in the prompt is unit-tested as valid.
11. P2s: empty-bar desync (padding repair), pickup labelled "Pickup" then printed bar numbers (`Timeline.barLabels`), bass-clef brass auto-octave targets median D3, key-signature wrap re-spells notes in the new key (concert F#/C# major -> trumpet Ab/Eb), unfriendly E#/B#/Fb/Cb outside the key are re-spelled.

Interface changes (all additive)
- `Timeline` gained `order` (play order, written bar per played bar), `measureCount`, `barLabels`, `barTotal`, `hasRepeats`. `measureStartsQ` is now per PLAYED bar (identical to before when there are no repeats). New helpers `slotAt`, `firstQ`, `unrollMeasures`, `readFlow`. `measureAt(tl, q)` returns the written bar.
- `Player`: `onPosition(q, measure, offsetQ)` (extra arg), `stepBar(delta)`, `measureCount` = written bars. `ScoreViewHandle.setPosition(q, measure, offsetQ?)`, `ScoreView` prop `zoom`.
- `Transport` props `barLabel`, `barTotal` (optional). `SavedScore.sourceAuto?`.
- `GET /api/omr` -> `{ claude, audiveris, passcode }`. New error codes: `unauthorized` 401, `rate_limited` 429, `too_long` 422.
- New files: `lib/omrGuard.ts`, `lib/repair.ts`, `app/icon.svg`; fixtures `tests/fixtures/qa-*.musicxml`, `bass-part.musicxml`.

Not fixed / left for refine
- Live Claude OMR is still untested (no key); the new prompt and the 16000-token ceiling are unvalidated against real scans. Output-format redesign (line-per-measure notation), EXIF/crop/contrast preprocessing and per-system crops are not done. Source-instrument/clef hints are not sent to the model (would extend the API body).
- Rate limit is per server instance (serverless caveat, see README); no global budget cap.
- Multi-part scores still play through one instrument (no part picker); trombone/baritone remain identical; D.C./D.S. only via `<sound>` attributes (no text-only "D.S." words); `Fine`/`tocoda` are treated as end-of-bar.
- Review step after OMR (show detected key/time/clef and let the user correct), press-and-hold BPM repeat, "bars per line" option, .mxl size cap, CSP headers, `window.confirm` delete, `role="img"` for the score SVG: not done.
- Prev/Next bar on a repeated bar follows the play order (so "next" after the first ending goes back to bar 1): intended, but worth a look in refine.
- Enharmonic key choice for E major -> F# vs Gb (QA M3) not changed; downloaded MusicXML after auto-octave still has the octave baked in (QA M4).

## Refinement Log
One commit per logical change ("Brass Reader refine: ..."). Tests after the pass: 223 vitest unit tests, 38 Playwright e2e tests, `npm run build` passes; the production build was also smoke-tested with `next start` (PDF read, sample loading and playback under the new content security policy, 0 console errors).

### 1. Reading (OMR)
- **Output format redesign** (`lib/omrNotation.ts`, new). The model no longer writes MusicXML. It writes one line per bar in a compact text format (`7: C5:q D5:e E5:e r:h`), with accidentals only where a sign is printed. `parseNotation()` is tolerant (unknown tokens are collected, never thrown) and `notationToMusicXml()` builds the MusicXML in code: key signature and in-bar accidental rules, ties (a "tie" to another pitch is dropped as a slur), tuplets, dots, chords, grace notes, pickup (`0:`), multi-bar rests (`17-24: R`), repeats, endings, segno/coda/fine/D.C./D.S., mid-piece key/time/clef changes, several parts, tempo. Roughly ten times fewer output tokens than MusicXML, cannot be malformed, and each bar can be checked and re-read alone. A reply in MusicXML is still accepted (fallback path).
- **Prompt rewrite** (`lib/omrPrompt.ts`): explains the purpose, the format, staff-position anchors for treble and bass clef, bar-sum self-check, photo handling, what to ignore, multi-page and top/bottom-half continuity, multi-staff scores, `? <bar>: <doubt>` lines for real uncertainty, `NOT_MUSIC` for non-music pictures. The worked example in the prompt is unit-tested (parses with no problems, every bar adds up, plays in the right order).
- **Hints** from the player are sent and used: "written for" instrument/clef, and the name of one part to read on a multi-staff page (sanitised, 40 chars). Every image is labelled ("Page 2 of 3, top part").
- **Targeted second look** (`lib/omrCore.ts`): bars that fail the bar-sum check (or hold unreadable tokens) are sent back once, with what was read and what is wrong; the reply holds only corrected lines (or a corrected `time:` header) and is merged by part and bar. The better of the two readings wins. At most two model calls per scan; the second is skipped if the first took over 140 s (server limit 300 s). It is a fresh single-turn request (no replayed assistant turn), with a cache breakpoint on the system prompt and on the last image so the second call reads the images from the prompt cache.
- **Route** (`app/api/omr/route.ts`, `lib/omrMessage.ts`): `max_tokens` default 32000 (range 4000-64000; it covers the model's reasoning too), optional `OMR_EFFORT`, typed error chain (busy, key rejected, unreachable), token usage logged server-side, image type sniffed from magic bytes (the declared type is not trusted; non-images are 400). Request gained `tiles` and `hints`; reply gained `flags`. New code `not_music` (422).
- **Bar check** (`lib/repair.ts`): a short bar is no longer padded/flagged when it completes the pickup before a repeat sign, Fine or D.C./D.S., or when a repeat sign splits a bar in two. Issues carry the part index.
- **Photo clean-up on the phone** (`lib/imagePrep.ts` new, `lib/omrClient.ts`): EXIF orientation applied explicitly, manual rotate button per page, greyscale, lighting flattened (per-tile paper estimate, bilinear), contrast stretched without hard thresholding; sent at up to 2200 px. Pieces of up to 3 pages are cut into a top and bottom image at a strictly blank band between systems (never through a line joining staves; no cut on tilted photos), doubling the detail the reader gets. PDFs get the same cut but no clean-up. Canvases are released after encoding.
- **Review step** (`components/Uploader.tsx`): after reading, nothing is saved until the player has seen clef / key / time / bar count, the list of things to check, and (for several parts) chosen a part. They can edit the title, fix a miscounted key signature without a new scan (`rekeyXml()` re-derives every pitch from the printed accidentals), read again, or open the score. Warnings for a clef that contradicts "written for" and for near-empty readings.
- **Part picker** (`extractPart()`, score page): multi-part scores show a Part select (one part or all together), remembered per score; an auto-detected "written for" follows the part.
- **Bars to check on the score**: the reader's doubts are saved with the score; flagged bars are underlined on the score and listed in a collapsible panel where each line jumps to its bar.

### 2. Playback
- iOS audio: `lib/audioUnlock.ts` is called synchronously inside the Play gesture (silent-buffer unlock; `navigator.audioSession.type = 'playback'` so the ring/silent switch does not mute on Safari 16.4+; silent looping `<audio>` fallback on older iOS, stopped on pause). If the context will not start the app says "tap Play once more". A suspended/interrupted context (call, lock screen) and a hidden tab pause playback cleanly. "No sound?" help sits next to the sound status.
- The cursor is drawn behind the scheduling clock by `outputLatency + baseLatency` (Bluetooth speakers); scheduling itself is unchanged.
- Count-in is a real bar of beats: before a pickup it counts up to the pickup (plus a whole bar if that would be under two clicks). Metronome and count-in use dotted-quarter beats in 6/8, 9/8, 12/8, and a pickup bar no longer gets a false downbeat.
- Sample loading: spinner and "Loading ... sound", "Try loading again" on fallback, samples kept in the browser Cache API (works offline after the first load). The printed metronome mark seeds the BPM. Click / count-in are remembered. Hold − / + to run the tempo. Screen wake lock while a score is open.
- Cursor updates do nothing unless the step or bar changed (no layout work every frame); auto-beaming is switched on for scores without beams.

### 3. UI
- Home: brand header, one big "Take a photo" action, tips, library cards with origin and age, in-page delete confirmation (no `window.confirm`), clear empty / loading / storage-blocked states, "Score not found" page.
- Uploader: page thumbnails with number, rotate, reorder, remove; progress with seconds counter; errors with Try again / free reader / open MusicXML.
- Player: drawn icons (no emoji glyphs), larger Play, tabular bar counter, BPM field with caption, lamp-style Click / Count-in toggles, status pill, collapsible checks. Checked with screenshots at 320, 375 and 390 wide portrait, 844x390 landscape and 1280x800 desktop, dark and light.

### 4. Security and performance
- Security headers on every response (nosniff, frame deny, referrer policy, permissions policy) and a content security policy in production; `/api` responses are `no-store`; `x-powered-by` removed.
- `/api/omr`: overall daily ceiling (`OMR_DAILY_LIMIT`, default 300, counted only for requests that reach a reader) on top of the per-address limit; image count cap follows the page/tile layout (6 pages, 12 images); magic-byte check; hints and tiles validated.
- `.mxl` zip-bomb guard and a 30 MB cap on score text.
- Long scores: a 160-bar part draws in about 1.6 s on desktop Chromium and plays at 60 fps with the cursor inside its bar (e2e). The source-instrument hint is memoised (it re-parsed the XML on every bar change).

### Interface changes (additive unless noted)
- `POST /api/omr` body: `tiles?: number[]`, `hints?: { instrument?, part? }`. Reply: `flags: { bar, text }[]`. Max images 12 (6 pages).
- `OmrDeps.callClaude(req: OmrRequest, followUp?: string)` (was `(images, retry?)`); `runOmr(req, engine, deps)` takes the request object (changed).
- `prepareFiles(files | { file, rotate }[], onProgress?)` returns `tiles`; `callOmr({ images, tiles, hints }, engine)` (changed). `imageToDataUrl` / `pdfToDataUrls` removed (unused).
- `SavedScore.flags?`, `SavedScore.partIndex?`. `BarIssue.part`. `ScoreView` prop `flagged`. `Player.play()` returns `Promise<boolean>`, `Player.onBlocked`, `Player.outputDelay()`, exports `beatLengthQ`, `countInClicks`.
- New files: `lib/omrNotation.ts`, `lib/omrMessage.ts`, `lib/imagePrep.ts`, `lib/audioUnlock.ts`, `components/Icons.tsx`; tests `notation`, `imagePrep`, `routeModel` (unit) and `refine.spec.ts` (e2e).
- New env: `OMR_EFFORT`, `OMR_DAILY_LIMIT`. `OMR_MAX_TOKENS` default is now 32000.

### NOT TESTED (be honest with the user about these)
- **The real reader.** No API key exists here, so the new prompt, the text format and the second look have never been run against a real model or a real photo. Everything around the model call is tested with the call replaced by a fake; reading accuracy on real charts is unknown. First thing to do with a key: scan 5-10 real parts, compare, and tune the prompt.
- Token use, cost and time per scan, prompt-cache hits on the second look, and behaviour at the 300 s limit are estimates.
- Real iPhone / Android hardware: camera capture, EXIF from a real camera, HEIC, the silent switch, audio-session behaviour, wake lock, Bluetooth delay, canvas memory on old phones. Only desktop Chromium (with phone-sized viewports) was used.
- The photo clean-up and page cut were tested on synthetic pages (gradients, staves, joins), not on real photographs. Skew, curl and perspective are left to the model.
- Audiveris fallback end to end.

### Left for later
- Reading long pieces in batches of 2 pages with the previous reading as context (today all pages go in one request; more than 3 pages are not cut in halves).
- Correcting clef or time signature without a rescan; editing single notes.
- Loop a range of bars for practice; swing playback.
- A shared, durable rate limit (KV) instead of per-instance memory.
- No server-side `fallbacks` parameter on the model call (a refusal on sheet music is unlikely; it is reported as an error).
