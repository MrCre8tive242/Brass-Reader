# Brass Reader

Point your phone at a page of sheet music and Brass Reader reads it, shows it with a line that moves through the notes, and plays it with a brass sound at your tempo. Pick another instrument and both the sound and the written part change: transposed, in the right clef and octave. Made for brass and drum groups: Bb trumpet, mellophone, baritone (bass clef), trombone, sousaphone.

Reading is automatic and can make mistakes. Always check the notes against your sheet.

## Using it at rehearsal

1. **Add the music.** Tap **Take a photo** (or **Photos or PDF** for pictures you already have, up to 6 pages). Lay the page flat in good light, fill the frame, and hold the phone straight above it. One page per photo. If a photo comes out sideways, tap the round arrow on it. Put the pages in order with the arrows under them.
2. **Say what it is written for** if you know (for example Trombone). If you leave it on "Detect from the music", treble clef is taken as Bb trumpet and bass clef as trombone. If the page is a score with several instruments, open "The page shows several instruments" and type the name of your part.
3. **Tap Read.** It usually takes 20 to 60 seconds. Keep the screen open.
4. **Check the reading.** The app shows the clef, key, time signature and number of bars it found, plus a list of bars it is not sure about ("Bar 7 may be misread"). Compare with the top of your page.
   - Key signature wrong? Choose the right one from the list and the notes are corrected on the spot.
   - Clef or time signature wrong, or lots of bars flagged? Tap **Read again**, or retake the photo closer and sharper.
   - Several parts found? Choose yours.
   - Fix the title if you like, then tap **Open score**.
5. **Play along.**
   - Big button: play and pause. The buttons beside it step one bar back and forward. Tap any bar on the score to jump there.
   - **BPM**: type a tempo (30 to 240), nudge it with − and + (hold to go faster), or tap the **Tap** button in time. If a metronome mark was printed on the page, it is used as the starting tempo.
   - **Click** turns on a metronome. **Count-in** gives you one bar of clicks before the music starts (before a pickup it counts up to the pickup).
   - **Play as** changes the instrument: the sound and the written notes. **Written for** is what the page was printed for; change it if the notes sound a step or more off.
   - **A−** and **A+** change the size of the music. Turning the phone sideways gives the score the whole screen.
   - Bars the reader was unsure about are underlined in red with a small question mark. "Bars to check" lists them; tap a line to jump to that bar.
6. **Take it with you.** **Download MIDI** and **Download MusicXML** save the part as shown (for your chosen instrument and tempo).

Everything you read is kept in **Your music** on that phone or computer, so you only scan a tune once. It is not shared between devices. To move a tune to another phone, download the MusicXML and open it there with **Open MusicXML**.

### No sound?

- Turn the volume up with the side buttons.
- iPhone: flip the ring/silent switch off silent, or use headphones or a speaker. (On recent iPhones the app plays even on silent; on older ones it may not.)
- Tap Pause, then Play again. Phones only let a page make sound after a tap.
- The first time you use an instrument its sound is downloaded and then kept on the phone. With no signal and no saved sound you get a plain synth sound; tap "Try loading again" once you have signal.
- On a Bluetooth speaker the sound arrives late. On most Android phones the moving line waits for it; on iPhone it may run slightly ahead.

### Add it to your home screen

Open the site in Safari (iPhone) or Chrome (Android), then Share, **Add to Home Screen**. It opens like an app. On phones that support it, the screen stays awake while a score is open.

## Setting it up (once, by whoever runs it)

```bash
cd brass-reader
npm install
cp .env.example .env.local   # then fill in ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

Opening a `.musicxml`, `.xml` or `.mxl` file works with no keys at all. Scanning photos and PDFs needs the reader.

### Settings (environment variables)

| Name | Needed? | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes, for scanning | Key for the reader (Claude vision). Without it the app says "The reader is not set up". Each scan is billed to your Anthropic account: expect cents, not dollars, per scan with the default model, and check the usage page after the first few. |
| `APP_PASSCODE` | strongly recommended on any public address | A word you choose. The app asks each player for it once and remembers it on their phone. Without it, anyone who finds the address can spend your key. |
| `OMR_MODEL` | optional | Which model reads the music. Default `claude-sonnet-5-5`. |
| `AUDIVERIS_URL` | optional | Address of the backup reader (see below). Adds a "Try free reader" button when the main reader fails. |
| `OMR_TOKEN` | optional | Shared secret sent to the backup reader as `X-OMR-Token`. Set the same value on both sides. |
| `OMR_EFFORT` | optional | How hard the model thinks: `low`, `medium`, `high`, `xhigh` or `max`. Unset uses the model's default. Higher is slower and costs more. |
| `OMR_MAX_TOKENS` | optional | Ceiling on one reply, thinking included (default 32000, range 4000 to 64000). A reply that hits it gives "too long, try fewer pages". |
| `OMR_RATE_LIMIT`, `OMR_RATE_WINDOW_MIN` | optional | Scans allowed per network address: default 10 every 10 minutes. |
| `OMR_DAILY_LIMIT` | optional | Scans allowed per day for everyone together: default 300. |

The two limits are kept in the server's memory. On Vercel each server instance counts on its own, so they slow abuse down but are not a hard cap. For a hard cap, set a spending limit on the Anthropic account and add a Vercel Firewall rate-limit rule for `/api/omr`.

### Put it on Vercel

1. Push the repository and import it in Vercel ("Add New Project").
2. Set **Root Directory** to `brass-reader`.
3. Under Settings, Environment Variables add `ANTHROPIC_API_KEY` and `APP_PASSCODE` (and any optional ones).
4. Deploy, open the address on your phone, enter the passcode on the first scan.

`vercel.json` allows `/api/omr` to run for up to 300 seconds. Plans with a lower limit will cut long readings off; scan one or two pages at a time there.

### Backup reader (Audiveris)

Vercel cannot run Java, so the free Audiveris reader runs as a separate Docker service in `audiveris-server/` (its README has Fly.io, Render and Railway steps). After deploying it, set `AUDIVERIS_URL` (use https) and `OMR_TOKEN` in Vercel and redeploy. The app tries the main reader first and falls back to Audiveris if it fails. Everything works without it. The link between this app and the Docker service has not been tested end to end yet.

## How it works

- **Photo clean-up (on the phone):** the photo is turned the right way up (camera EXIF data, plus the manual rotate button), made greyscale, the uneven lighting is flattened and the contrast stretched so the paper is white and the ink dark. Pieces of up to 3 pages are cut into a top and a bottom image at a blank gap between systems, so the reader sees twice the detail. Images are sent as JPEG, at most 2200 px on the long edge, shrunk further only if the request would exceed 4 MB.
- **Reading (`POST /api/omr`):** the model is asked to write what is printed in a compact text format, one bar per line (`7: C5:q D5:e E5:e r:h`), with accidentals only where a sign is printed. The server applies the key signature and bar rules and builds the MusicXML itself, so the result is always well-formed. It then checks that every bar adds up. Bars that do not are sent back once for a second look at just those bars; whatever still fails is padded with rests (so the cursor stays in step) and reported as "may be misread". The model can also flag bars it was unsure about. At most two model calls per scan.
- **Request:** `{ images: dataUrl[], tiles?: number[], hints?: { instrument?, part? }, engine?: 'auto'|'claude'|'audiveris' }`. **Reply:** `{ musicxml, engine, warnings: string[], flags: { bar, text }[] }` or `{ error, code }` (401 passcode, 429 limit reached, 503 not set up, 502 reader failed, 422 `too_long` or `not_music`, 413 too large, 400/415 bad request). `GET /api/omr` reports which readers are configured, with no secrets. Reader errors are logged on the server; players only see plain messages.
- **Transposing:** the part as read goes to concert pitch, then to the written part for "Play as", with key signature, accidentals, clef and an automatic octave shift into the instrument's range.
- **Playback:** notes are scheduled on the audio clock and the line follows that clock, drawn late by the device's reported output delay. Repeats, endings and D.C./D.S. jumps are played in order.

| Instrument | Clef | Written to concert | Sound |
|---|---|---|---|
| Bb Trumpet | treble | down a major 2nd | trumpet |
| Mellophone (F) | treble | down a 5th | french horn |
| Baritone (bass clef) | bass | as written | trombone |
| Trombone | bass | as written | trombone |
| Sousaphone | bass | as written | tuba |

## Known limits

- The reader has not yet been run against real photos from this build (no API key was available while building). The steps around it are tested; how well it reads your charts is something to find out on the first rehearsal. Clean, flat, sharp photos of printed parts are the best case; handwriting and tilted or creased pages are the worst.
- Dynamics, articulation, slurs, lyrics and text are not read. Grace notes are drawn but not played.
- A wrong clef or time signature can only be fixed by reading again (a wrong key signature can be fixed in the review step).
- D.C. and D.S. are followed once; on that pass repeats are not taken and the last ending is played.
- Baritone and trombone sound and read the same.
- Scores live in one browser on one device. Clearing the browser's site data removes them.

## Tests

- `npm test`: unit tests (reading format and MusicXML building, bar checks, transposition, timeline, MIDI, photo clean-up, player timing, request handling with the model replaced by a fake).
- `npm run e2e`: Playwright against `next dev` with the preinstalled Chromium (`/opt/pw-browsers/chromium`; do not run `playwright install`). `/api/omr` is stubbed in these tests.
- `npm run build`: production build.
- Nothing in the suite calls the real model.
