# Brass Reader — BUILD_PLAN

## STATUS
Phase: BUILD
Next model: Sonnet (build agents) → test agents → fixer → Fable (high) refine
Last updated by: Sonnet (build agent)
Current step: DONE (steps 1-4, 6-8; step 5 owned by another agent)

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

## Refinement Log
(refiner writes here)
