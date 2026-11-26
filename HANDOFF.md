# Brass Reader — Handoff

Start a fresh chat with: "Read HANDOFF.md and continue." Sonnet is enough for most fixes. Use Opus only for planning a new feature.

## What it is
- A Next.js + TypeScript app in its own repo, MrCre8tive242/brass-reader (branch `main`). It was moved out of Main-chat (old PRs #29/#30 there).
- Live at https://brass-reader.vercel.app.
- The user is a Junkanoo brass player who mostly uses a phone. Answer in plain words and keep answers short.

## Features (all live)
- **Reading:** reads a photo, screenshot or PDF of sheet music into MusicXML with Claude vision (`app/api/omr/route.ts`, `lib/omr*.ts`). Dense pages are cut into zoomed strips of about 2 lines each (`planStrips` in `lib/imagePrep.ts`), read in parallel, then merged (`mergeStripReadings` in `lib/omrNotation.ts`).
- **Playback:** a moving line that glides between notes (`lib/glide.ts`), bar highlight, play/pause, back/forward, BPM, count-in, click.
- **Instruments:** trumpet, mellophone, baritone (bass clef), trombone, sousaphone. The written part is transposed. MIDI export.
- **Practice drawer:**
  - loop and speed trainer
  - band / ensemble parts
  - pitch check
  - record yourself
  - fingerings: Numbers, Valve dots, Both or Off; trombone shows slide positions
  - range warnings
- **Drums:** record your own drum line, or use the synth starter kit and step editor (`DRUMS_PLAN.md`).
- **2-bar view:** the two bars sit side by side, with fingerings under the notes (`components/TwoBarView.tsx`).
- **Download video:** MP4 when the browser can make one, otherwise WebM or a real-time recording (`lib/videoRender.ts`, `components/VideoDialog.tsx`).

## Docs
- `BUILD_PLAN.md`, `PHASE2_PLAN.md`, `DRUMS_PLAN.md` and `PHASE3_PLAN.md` hold the spec, file maps, decisions and refinement logs.
- `README.md` is the player guide.

## Deploy (Vercel MCP)
1. Push to the branch.
2. Call `create_deployment` with:
   - teamId `team_vrIkDviVBbFJerbCSm6AoYK6`
   - `skipAutoDetectionConfirmation: "1"`
   - requestBody: `{name/project:"brass-reader", target:"production", gitSource:{type:"github", org:"MrCre8tive242", repo:"brass-reader", ref:"main", sha:<commit>}}` (the project root directory is now empty: the app is at the repo root)
3. Smoke test: `GET /api/omr` should return `{"claude":true,"passcode":true}`.
4. The Vercel env vars (ANTHROPIC_API_KEY, APP_PASSCODE) are already set; there's no key in the cloud container.
5. The user does NOT want preview links, because they need the env vars. Deploy straight to production after the tests pass.

## Tests
- `npm test`: vitest, 522 tests.
- `npm run e2e -- --trace off`: Playwright, 144 tests. Chromium is preinstalled; never run `playwright install`.
- `npm run build`
- All green at commit 0284272.

## Waiting on the user (untested here)
- Re-scan "Juicy Suzzi" (a dense bass-clef baritone page) with the new strip reading. Before: 70 s and 8 "not sure" bars, mostly chords, plus bars 24–25 hidden by a "101%" zoom bubble in the screenshot.
- On a real iPhone: video saves to Photos/WhatsApp; the smooth line and the side-by-side 2-bar view on a phone.
- Real drummers, how the synth kit sounds, pitch check with real horns, and alternate fingerings (needs a teacher).

## Ideas not built
- If chords stay uncertain: a "chord bars" second look that zooms into only the flagged bars.
- Detect and warn about phone overlays (zoom bubbles) in screenshots.

## Conventions
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WPNtdVdXxiy2wHAzy8VcDE
  ```
- No model names in code or docs.
