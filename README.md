# Brass Reader

Mobile-first web app for brass players. Photograph or upload sheet music (photo, PDF, or MusicXML), see it drawn with a moving playback line and highlighted bar, play it with a brass sound at your tempo, and switch instrument (Bb trumpet, mellophone, baritone, trombone, sousaphone). Switching changes both the sound and the written part (transposition, key signature, clef, octave). Download MIDI and MusicXML. Scans are stored on your device (IndexedDB), so you never pay to rescan.

Reading is automatic. Always check the notes against your sheet.

## Run locally

```bash
cd brass-reader
npm install
cp .env.example .env.local   # or create it, see below
npm run dev                  # http://localhost:3000
npm test                     # unit tests (vitest)
npm run e2e                  # Playwright (see "Tests")
npm run build
```

Opening a `.musicxml`/`.xml`/`.mxl` file works with no keys at all. Scanning photos/PDFs needs a reader (below).

## Environment variables

| Name | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Vercel / `.env.local` | Primary reader (Claude vision). Without it the app shows "Add ANTHROPIC_API_KEY in Vercel". |
| `OMR_MODEL` | optional | Model id for the reader. Default `claude-sonnet-5-5`. |
| `AUDIVERIS_URL` | optional | Base URL of the backup Audiveris service. Enables the "Try free reader" fallback. |
| `OMR_TOKEN` | optional | Shared secret sent as `X-OMR-Token` to the Audiveris service. |
| `APP_PASSCODE` | **recommended for any public deploy** | If set, `/api/omr` only works for clients that send the header `X-App-Passcode: <value>`. The app asks for it once (stored in the browser's localStorage) and shows "That passcode is not right." if it is wrong. Share it only with your group. Unset = no passcode (fine for local use). |
| `OMR_RATE_LIMIT` / `OMR_RATE_WINDOW_MIN` | optional | Best-effort per-IP limit on `/api/omr`: default 10 requests per 10 minutes, then HTTP 429. In-memory per server instance, so on serverless it slows abuse but is not a hard cap; add a Vercel Firewall rate-limit rule for a real cap. |
| `OMR_MAX_TOKENS` | optional | Output ceiling for one reading (default 16000, max 32000). If a reading hits it the user gets a "too long, try fewer pages" message. |

## Deploy to Vercel

1. Push the repo, then in Vercel choose "Add New Project" and import it.
2. Set **Root Directory** to `brass-reader`. Framework is detected as Next.js; `vercel.json` raises the `/api/omr` function limit to 300 s (needs a plan that allows it; Hobby caps lower, so lower `maxDuration` there).
3. Add `ANTHROPIC_API_KEY` and a long random `APP_PASSCODE` (and optionally `OMR_MODEL`, `AUDIVERIS_URL`, `OMR_TOKEN`) under Settings, Environment Variables. Without `APP_PASSCODE` anyone who finds the URL can spend your API key.
4. Deploy. Open the site on your phone and use "Add to Home Screen".

Requests to `/api/omr` must stay under Vercel's 4.5 MB body limit; the app shrinks photos to 2000 px (JPEG q0.85) and rasterises at most 6 PDF pages on the device before sending.

## Backup reader: Audiveris

Vercel cannot run Java, so Audiveris runs as a separate Docker service in `audiveris-server/` (see its README for Fly.io / Render / Railway steps). After deploying it, set `AUDIVERIS_URL` (and `OMR_TOKEN`) in Vercel and redeploy. With `engine: auto` the API tries Claude first and falls back to Audiveris on failure; the user can also pick "Try free reader" after an error. The app works fine without it.

## How it works

- **Reader:** `POST /api/omr` with `{ images: dataUrl[], engine?: 'auto'|'claude'|'audiveris' }` returns `{ musicxml, engine, warnings }` or `{ error, code }` (401 passcode, 429 rate limited, 503 no key / no Audiveris, 502 reader failed, 422 reading too long, 413 too large, 400/415 bad request). `GET /api/omr` returns `{ claude, audiveris, passcode }` flags (no secrets). Reader errors are logged on the server and shown to the user as generic messages. The Claude reply is cleaned, parsed and checked for notes; on failure it retries once with the parse error.
- **Pipeline:** source MusicXML (written for the instrument you pick under "Written for", default trumpet) -> concert pitch (`lib/transpose.ts`) -> written part for "Play as", with key signature, accidentals, clef swap and automatic octave shift into the instrument's range. A `<transpose>` element is added to the part so the timeline always yields sounding pitch.
- **Playback:** `lib/player.ts` schedules notes on the WebAudio clock (smplr soundfont, oscillator fallback if the CDN is unreachable). The cursor and bar highlight follow the audio clock via `requestAnimationFrame`.
- **Instruments:**

| Instrument | Clef | Written to concert | Sample |
|---|---|---|---|
| Bb Trumpet | treble | -2 | trumpet |
| Mellophone (F) | treble | -7 | french horn |
| Baritone (bass clef) | bass | 0 | trombone |
| Trombone | bass | 0 | trombone |
| Sousaphone | bass | 0 | tuba |

## Limitations (v1)

- Repeats, volta endings and simple D.C./D.S. al Fine/Coda (marked with `<sound dacapo/dalsegno/fine/tocoda/coda/segno>`) are unrolled into the play order used by audio, cursor and MIDI export. Bar counter and highlight use the written bars; Prev/Next bar follow the play order and tapping a bar seeks to its first pass. On a D.C./D.S. pass repeats are not taken and the last ending is played.
- Multi-part scores are all transposed and played together; the player is aimed at single-line brass parts.
- Grace notes are drawn but not played. Tempo markings in the file are ignored (use the BPM control).
- Soundfont samples load from a public CDN; offline you get a plain synth.

## Tests

- `npm test` runs unit tests (transposition, timeline, MIDI, OMR plumbing with the model call injected).
- `npm run e2e` runs Playwright against `next dev` using the preinstalled Chromium (`/opt/pw-browsers/chromium`, configured in `playwright.config.ts`; do not run `playwright install`). The upload test stubs `/api/omr`.
- Live OMR tests require a real `ANTHROPIC_API_KEY` and are not part of the suite.
