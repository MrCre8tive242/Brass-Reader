# QA report: mobile UX, accessibility, music correctness, OMR, security

Tester: QA agent 2. Dev server on :3200. App source was not edited.
Scripts and screenshots: /tmp/claude-0/-home-user-Main-chat/8c0f9322-8acb-5fb5-bd40-10249832903a/scratchpad/qa2/
Devices: iPhone 13 and Pixel 7 (portrait and landscape), 1280px desktop; dark and light. Test score: a generated 48-bar trumpet tune (long.musicxml).

## Summary of what works
- No horizontal overflow on any viewport (scrollWidth == clientWidth everywhere).
- Auto-scroll kept the cursor visible above the transport in all 14 samples per device. Next/Prev x30 and seek also keep the cursor in view.
- Transposition math is correct for all 5 instruments on all 4 fixtures (see Music section). Sounding pitch = concert pitch (+ auto-octave) for every instrument.
- Every button, select and input has an accessible name. Landmarks, `lang` and a single h1 are present. Contrast passes except the one case noted in P2.
- No-key error path: `/api/omr` returns a clean 503 JSON; bad body gives 400.

## P0

### P0-1. /api/omr has no auth, rate limit or per-IP cap, so anyone with the URL can drain the API key
- Repro: `for i in 1..N: POST /api/omr {images:[<valid 3MB jpeg data URL>]}`. Each call runs a Claude vision request with `max_tokens: 64000`, up to 300 s. Every failed parse triggers a second full call (images plus the previous reply) on top of that.
- Expected: some throttle (per-IP and global), optional shared passcode or Vercel Firewall rule, and a daily budget cap.
- Actual: nothing in `app/api/omr/route.ts` or `lib/omrCore.ts` (grep for rate/auth/token finds only the Audiveris OMR_TOKEN). A request with `Content-Type: text/plain` and a JSON body also parses via `req.json()`, so cross-site pages can fire it.
- Suggested fix: Upstash/Vercel KV or Vercel Firewall rate limit; a simple `X-App-Pass` env passcode for a private group tool; lower `max_tokens` (a 48-bar single-line part is under 20k tokens); cap retries.
- Severity note: P0 only if deployed publicly with a real key. It is fine for local use.

## P1

### P1-1. BPM number field cannot be typed into (keyboard or mobile keypad)
- Repro: focus the BPM input, select all, type "150" (Playwright `keyboard.type`, 50 ms delay).
- Expected: 150.
- Actual: ends at 240. The first keystroke "1" is clamped to 30 on every `onChange`, then "305" goes to 240. Backspace to empty is rejected, so the field snaps back to its old value. `fill('150')` works but real typing does not.
- Impact: the only ways to set tempo are -/+ (1 bpm per tap, no press-and-hold, so 100 to 140 is 40 taps) and Tap tempo.
- File: components/Transport.tsx (the BPM input `onChange`). Fix: keep a local draft string, commit and clamp on blur or Enter. Add press-and-hold repeat, and perhaps a +/-5 step.

### P1-2. Phone landscape shows no score until playback starts, and very little during it
- Repro: Pixel 7 landscape (863x360), open any score.
- Actual: the topbar, two selects, the "Sound:" line and the 2-row transport (about 110 px) fill the viewport. The score card is completely below the fold on load (pixel7-l-dark-player-paused.png). During playback about 1.5 systems are visible (iphone13-l-dark-player-playing.png).
- Expected: the score is the main content in landscape.
- Fix: in landscape, collapse the pickers into a menu or sheet; put BPM, click and count-in in one row beside the main buttons; hide the title bar.
- File: app/globals.css (the `@media (orientation: landscape)` rule), components/Transport.tsx.

### P1-3. Portrait transport is 3 rows (about 177 px of 664 px) and is not really one-handed
- At 375 to 412 px wide the Count-in checkbox wraps to a third row. Play is at the left edge, so a right-handed thumb has to reach across. The bar counter is at the far right but is not a control.
- Fix: one row for prev/play/next, with play centered or right-aligned; move BPM, click and count-in into a "Tempo" popover or a single compact row; make the transport collapsible.

### P1-4. Score legibility on phone is marginal and there is no zoom
- Portrait OSMD zoom is fixed at 0.62; the stave is about 22 px high at 390 px width. There is no zoom control, and pinch zoom fights the tap-to-seek handler.
- Fix: add an A-/A+ zoom (persisted per device) and a "bars per line" choice. The zoom value lives in ScoreView.tsx (`osmd.zoom = w < 520 ? 0.62 ...`).

### P1-5. Default "Written for" is always Bb Trumpet, so bass-clef scans play wrong
- A photographed trombone, baritone or sousaphone part with no `<transpose>` is treated as a trumpet part. It is transposed -2 semitones to concert, which sounds a whole step low if the player then picks Trombone.
- The Uploader only shows the "written for" select after files are added, and the MusicXML upload path skips it entirely (opens directly as trumpet).
- Fix: default `sourceInstrument` from the first clef (F clef means trombone); always show the picker before reading; for MusicXML with a `<transpose>`, infer from it (the code already honours it).
- Files: components/Uploader.tsx (`DEFAULT_SOURCE_INSTRUMENT`), lib/instruments.ts.

### P1-6. Repeats, D.S., D.C. and endings are ignored (disclosed in the plan)
- Marching-group charts nearly always have repeats and endings. Playback, the bar count and MIDI export will not match what the player performs.
- File: lib/timeline.ts (`<barline><repeat>` and `<ending>` ignored). Flag it in the UI too: "Repeats not played".

### P1-7. Validation does not check measure durations, so a bad OMR result plays and draws out of sync
- `validateMusicXml` only checks that there is at least one pitched note. Model output whose bars do not sum to the time signature (the most common OMR error) is accepted. Playback timing and the cursor will then drift against the real music.
- Fix: add a per-measure duration check (excluding pickup and last-bar), include the failing bar numbers in the retry prompt, and show a warning in the UI for bars flagged as irregular.
- File: lib/musicxml.ts, lib/omrCore.ts.

## P2

### Accessibility and keyboard
- **P2-1. No visible focus ring on "Take photo", "Photos or PDF" or "Open MusicXML".**
  - Repro: Tab on the home page. The focused element is the `sr-only` input (1x1 px, outline clipped), and the label has no `:focus-within` style. focus-photo-input.png shows no indication.
  - Fix: `.btn:focus-within { outline: 3px solid var(--accent); }`.
- **P2-2. Space on a focused checkbox toggles playback instead of the checkbox.**
  - Repro: Tab to "Click" or "Count-in", press Space. Playback starts and the checkbox stays unchecked.
  - Cause: the global keydown handler in app/score/[id]/page.tsx only exempts INPUT types other than checkbox. Fix: exempt checkbox, button and select, or check `e.target.closest('label, button')`.
- **P2-3. Light-mode primary button contrast.** White on #c25e00 is 4.29:1, under the AA 4.5:1 for 16px bold text. Darken accent to about #b45500. All other pairs pass: dark text 15.8, muted 7.0, light muted 5.4, danger 6.7 and 5.8.
- **P2-4. Touch targets under 48 px:**
  - Uploader page-reorder buttons ("‹ × ›") are 28x28.
  - Landscape phone: the media query sets the transport buttons, BPM field and checkbox labels to 44 px high.
  - Checkbox inputs are 22 px, though their labels are 48 px.
- **P2-5.** The score SVG has no `role="img"` or text alternative. `aria-live="off"` on the bar counter is fine, but screen-reader users get no playback state.
- **P2-6.** `themeColor` is dark only, with no `viewport-fit=cover`, so `env(safe-area-inset-bottom)` is 0 on notched iPhones in landscape. The transport can sit under the home indicator.

### Other UX
- **P2-7. Rotation while playing:** after resize from portrait to landscape the view does not re-scroll to the cursor. At bar 48 the cursor sat under the topbar (ip-rotated.png). ScoreView re-renders on resize but calls `place(..., false)` with scroll disabled.
- **P2-8.** Library delete uses `window.confirm`. It is OK on mobile but ugly and blocked in some in-app browsers.
- **P2-9.** First-load console showed a "Failed to load resource: 404" in the screenshot run (not reproduced in a later run; the URL was not captured). Re-check with `page.on('response')` on a clean profile.
- **P2-10.** The error-state buttons ("Try free reader", "Open MusicXML instead") are shown for any code other than no_key, no_audiveris and xml. The "free reader" button is therefore also shown when the free reader is not configured, and then returns a 503. Make `/api/omr` expose capabilities (GET) so the button is hidden when AUDIVERIS_URL is unset.

## Music theory audit (lib/transpose.ts, lib/instruments.ts)
Ran the code on a Bb-major scale, all 15 concert key signatures for trumpet and mellophone, and the 4 fixtures against 3 source instruments by 5 targets (60 combinations). Checks were: sounding pitch (via `buildTimeline` reading `<transpose>`) equals concert plus 12k, notes in range, double accidentals, and clef and key.

Correct:
- Trumpet: written is a major 2nd above concert. `transpose` diatonic -1, chromatic -2.
- Mellophone: written is a perfect 5th above concert. `transpose` diatonic -4, chromatic -7.
- Concert Bb major (-2) gives trumpet C (0) and mellophone F (-1), as expected. Spelling in this key is correct.
- Baritone and trombone: F clef (sign F, line 4), key unchanged, no `<transpose>`. Sousaphone: F clef, no `<transpose>`, concert (as written) in this app's convention.
- Auto-octave: a trumpet tune at concert 58-70 goes -1 octave for trombone/baritone and -2 for sousaphone, 100% of notes in range in all 60 combinations.
- Key changes mid-score are handled per part. Round-trip pitches are identical.
- GM programs (0-based): trumpet 56, trombone 57, tuba 58, French horn 60, all correct. smplr names "trumpet", "french_horn", "trombone" and "tuba" all exist in the smplr bundle. Baritone using the trombone samples and program matches the plan.
- Real MusicXML with `<!DOCTYPE ... PUBLIC ...>` parses fine.

Issues:
- **P2-M1. Far-sharp concert keys wrap to flats while the notes stay sharp-spelled (mixed spelling).**
  - Repro: concert F# major (6 sharps) written for trumpet gives key -4 (Ab major, via `wrapFifths`), but the notes are spelled G# A# B# C# D# E# G.
  - Expected: Ab Bb C Db Eb F G. The same happens for concert C# major, which becomes key -3 with sharp-spelled notes.
  - Cause: `transposePitch` keeps the interval-derived spelling unless |alter| > 1, so the key signature and the spelling disagree.
  - Fix: after `wrapFifths` changes the sign, re-spell with `spellInKey` (or always spell via `spellInKey`). Rare in brass literature.
- **P2-M2.** Interval-based spelling gives E#, B# and similar for chromatic notes outside the key (for example concert C-major chromatic passage to trumpet D D# E E# F#). It is technically correct but unfriendly, and players expect F or C natural. Consider preferring the enharmonic with fewer accidentals when the note is outside the key.
- **P2-M3.** Concert E major (4 sharps) gives trumpet F# major (6 sharps). Players would normally prefer Gb (6 flats), but both are valid. Optionally choose the enharmonic key with fewer accidentals (tie goes to flats for brass).
- **P2-M4.** Auto-octave bakes the shift into both the written and the sounding pitch. This is a documented deviation, but the `<transpose>` element then no longer round-trips to the original concert pitch in downloaded MusicXML for sousaphone or trombone. Mention it in the download label.
- **P2-M5.** Baritone and trombone are identical in every respect (clef, range, program, sample). The picker therefore offers a distinct option that does nothing, which is fine but worth saying in the UI.
- **P2-M6.** Multi-part scores are all played through one instrument, so stacked parts sound as chords. There is no part picker.

## OMR prompt and route review (lib/omrPrompt.ts, app/api/omr/route.ts)
Not called (no key). Verdict: plausible for clean single-line scans, risky for phone photos.

Concrete improvements:
1. **Accidental instruction is wrong or confusing.** "write the sounding alter ... taking the key signature into account" contradicts "WRITTEN pitches". Say: `<alter>` is the effective alteration of the note as written, including key signature and earlier accidentals in the bar.
2. **Phone-photo handling is absent.** Add: ignore skew, shadows and page edges; read the left-to-right order of systems top to bottom; do not read the title block as music. Add client-side preprocessing: auto-rotate by EXIF, crop to the page, boost contrast, and send per-system crops at higher resolution. 2000 px long edge at JPEG 0.85 for a full page leaves note heads about 8-10 px, which is the main accuracy limit.
3. **Pass context hints:** the selected source instrument, the expected clef and the part name. For example "this is a Bb trumpet part in treble clef; expect range F#3-C6".
4. **Validate structure server-side**, not just parse and one note: per-measure duration sums versus the time signature, matching tie start/stop, tuplet closure, the number of measures per page. Feed the exact bar numbers that fail into the retry prompt (retryPrompt currently carries only the first error string). Better still: also ask the model for a measure-count self check.
5. **Make the output more robust by changing the format.** A compact line-per-measure notation (for example `m5 | Bb4/8 C5/8 ... |`) that the server expands deterministically into MusicXML is much less likely to be malformed than 20k tokens of raw XML. The prompt example is minimal; a model-written 48-bar file is long and truncates.
6. **Missing instructions:** `<clef-octave-change>` (treble 8vb, bass 8va), cut time and common time symbols (`<time symbol=...>`), grace notes, ties versus slurs (do not emit `<tied/>` for slurs), `<tuplet>` notation elements, pickup bars (`number="0"`, `implicit="yes"`), mid-score key/time changes, and rest-only measures (whole-measure rests need `measure="yes"`). Repeats, endings, D.S. and codas should be captured as barlines and `<ending>` rather than skipped ("Skip repeat/ending logic" conflicts with P1-6).
7. **API call:** set `temperature: 0`; prefill the assistant turn with `<?xml version="1.0" encoding="UTF-8"?>` to avoid chatter; reduce `max_tokens`; check `stop_reason === 'max_tokens'` and return a "too long, try fewer pages" error (currently truncated XML only surfaces as a parse error); put the system prompt in a cacheable block (cache_control) since it is reused.
8. **Multi-page:** the model must continue measure numbers across pages. Consider reading page by page (separate calls, concatenated server-side) so a failure on one page does not lose all of them, and the output size stays bounded.
9. **Error text leakage:** `Claude request failed: ${e.message}` returns SDK error text (can include request IDs and rate-limit details) to the client. Log it and return a generic message.
10. Add a post-read review step in the UI: show the detected title, key, time signature, clef and bar count and let the player correct them before saving.

## Security quick look
- **Key exposure:** `ANTHROPIC_API_KEY` is read only in the route (server). No NEXT_PUBLIC usage and no key in client bundles (grep clean). OK.
- **Upload size limits:** client downscales; server checks `Content-Length` > 5.6 MB and total base64 length > 4,000,000 chars, max 6 images, and data-URL prefix only. Gaps: the content-length check is skipped for chunked bodies (`req.json()` reads everything on self-host; Vercel's own 4.5 MB limit covers the hosted case); the base64 payload and the image magic bytes are not verified (the SDK will reject, and the error text is passed back; see OMR item 9); a per-image cap is missing (one 3.9 MB image is allowed).
- **Rate limiting:** none (P0-1).
- **XML parsing (client and route):** uses @xmldom/xmldom 0.9.12. Tested a billion-laughs DTD and an external `SYSTEM "file:///etc/passwd"` entity: both are rejected with "entity not found" (xmldom does not expand DTD entities and does not fetch external DTDs), so there is no XXE or entity-expansion DoS. A standard MusicXML `<!DOCTYPE ... PUBLIC ...>` header parses fine. Side effect: a file that legitimately defines its own entity fails to open, which is acceptable. OSMD parses in the browser (DOMParser, no network fetch).
- **.mxl:** jszip loads the archive with no size or expansion cap, so a zip bomb could freeze the user's own tab (self-DoS only, no server impact). Cap the uncompressed size (around 20 MB) before `async('string')`.
- **Audiveris service:** `callAudiveris` forwards the images to AUDIVERIS_URL with `OMR_TOKEN` over whatever scheme is configured; make sure the URL is https and the token is set. server.py parses Audiveris output with ElementTree (trusted input) and limits MAX_BYTES to 10 MB.
- **Stored XSS:** none found. No `dangerouslySetInnerHTML` or `innerHTML` in app, components or lib. The score title (from the XML) is rendered as text by React.
- **Headers:** no CSP or other security headers are set in next.config.ts. Low priority.

## Not tested
- Real Claude OMR (no key), real Audiveris, real iPhone camera `capture`, actual audio output (only that the samples loaded and the player state toggled).
- Cursor-versus-audio drift (not measured; covered by another tester).
- Download file contents were not opened.
