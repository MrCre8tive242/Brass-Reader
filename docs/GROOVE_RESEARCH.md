# Junkanoo groove research (for the "play along with the drums" feature)

Date: 2026-11-25. Method: web search + page fetches from a sandbox. No audio was heard or analysed.

## 0. Honest summary

- Instrumentation is well documented. Rhythm patterns are NOT. In about 15 searches/fetches I found no published transcription, no BPM figure, no meter statement and no named beats for Junkanoo "rushing" music. Several sources say the drum is hard to notate at all.
- Therefore every step grid in section 3 is a **starting hypothesis built from generic descriptions**, not a transcription. The brass player's drummers must correct them by ear. Do not market them as "traditional".
- Best bet: ship an editable step sequencer with synthesized sounds plus the record-your-own-drummers loop (section 5). The recorded loop is the only route to guaranteed authenticity.

## 1. Instruments and roles (what sources actually say)

| Instrument | What is documented | Source |
|---|---|---|
| Goatskin drum (goombay) | Centrepiece of the rhythm. Skin stretched over a barrel/metal drum/frame and heated over a fire, candle or gas burner to tighten the skin and raise pitch. One drum can produce many timbres and dynamics, "almost impossible to notate" in European notation. Smithsonian programme text refers to a "Junkanoo beat" of repetitive, dominating goombay notes. | Nassau Guardian; Bahamian music resource summarised via search (grandbahamamuseum.org page would not load for me); Smithsonian 1994 programme book (PDF text not extractable) |
| Lead drum + additional drums | "Basic setup is a lead drum, additional drums, cowbell and whistle. Many rhythms are used." | N. Bethel 2007 |
| Bass drum / tom-tom | A Bahamian community discussion says ordinary bass drums with regular heads are also common; one article lists tom-tom and bass drum. | search snippets (reddit r/bahamas thread, low quality) |
| Cowbells | Played in pairs (one or more per hand); "interlocking patterns that hold the rhythm together"; "insistent cowbell ostinatos". Clappers inside, extremely loud. | Nassau Guardian; Museum of Miami; Afropop |
| Whistles | Rhythm instrument, not just a signal. Short repeated motifs, often call-and-response with drums; cowbell players often whistle while ringing. "Whistles cut through on top." | Nassau Guardian; Wikipedia Bahamian music |
| Horns | Older horns (bugle, conch, sheep horn, "black horn") played only a few notes, which shaped tunes like "A-Rushin' Through the Crowd". Signal horns/foghorns appear in one listing. | N. Bethel 2007; search snippet |
| Brass (trumpet, trombone, sousaphone, sax) | Added about 25 years before 2007 (led by the Music Makers). They carry melody; groups arrange hymns, pop, gospel, calypso etc. "into the Junkanoo beat". | N. Bethel 2007; Nassau Guardian; Tribune 2012 |
| Brakes, "foghorn" as a section, "kick drum" | **No source found.** I could not verify these as Junkanoo terms. Ask the drummers. | none |

Structure notes: Junkanoo music is call-and-response; judges score the music section on "tightness, variety, and whether the crowd starts moving" (Nassau Guardian). "Rake and scrape" is a different genre (saw + goatskin drum); a Bahamian musician says "the rhythms are different" from Junkanoo (via search snippet; verify).

## 2. Tempo and meter

- **No source gave a BPM or a time signature.** The Tribune (2012) quotes arranger Justice saying the time signatures are what is "held firm" in Junkanoo, but the article does not say which.
- A production-guide site (Melodigging) suggests steady bass-drum pulse, offbeat/cross-rhythms on mid/high drums, cowbell with accented offbeats and 16th-note motion. It is not scholarly, so treat it as weak.
- Nothing found supports a 6/8 or 12/8 reading, and nothing refutes it. Whether the cowbell is straight 16ths or triplet/swung must be settled by ear.
- App implication: do not hard-code a "correct" tempo. Expose BPM and a **swing/triplet toggle** (straight 16ths vs triplet feel) and let the drummers choose. Suggested slider 80 to 160 BPM, default whatever the drummers confirm. (The range is my engineering guess, not sourced.)

## 3. Proposed groove patterns (step grids)

**PROPOSED from sources: Melodigging production guide + Nassau Guardian/N. Bethel role descriptions (steady bass drum, interlocking cowbell, whistle motifs). NOT a transcription. NEEDS CHECKING BY EAR WITH REAL JUNKANOO DRUMMERS.**

Grid: 1 bar, 16 steps (4 beats x 4 sixteenths). `X` = accent, `x` = normal, `o` = ghost/soft, `.` = rest. Beats fall on steps 1, 5, 9, 13.

```
Step:            1 . . . 2 . . . 3 . . . 4 . . .
```

### Pattern A "Pulse" (simplest scaffold, 4-on-the-floor bass, offbeat cowbell)
```
Bass drum   X . . . x . . . X . . . x . . .
Lead drum   . . . . . . x . . . . . . . x .
Cowbell hi  . . x . . . x . . . x . . . x .
Cowbell lo  x . . . x . . . x . . . x . . .
Whistle     . . . . . . . . . . . . X . x .
```

### Pattern B "Interlock" (cowbell pair interlocking, syncopated lead drum)
```
Bass drum   X . . . . . x . X . . . . . x .
Lead drum   . . x . . o x . . . x . . o x .
Cowbell hi  x . x . x . x . x . x . x . x .
Cowbell lo  . . . x . . . x . . . x . . . x
Whistle     X . . . . . . . . . . . x x . .
```

### Pattern C "Call and response" (2 bars: bar 1 drums call, bar 2 whistle/horn answer)
```
Bar 1
Bass drum   X . . . x . . . X . . . x . . .
Lead drum   x . x . x x . x x . x . x x . .
Cowbell     x . x x . x . x x . x x . x . x
Whistle     . . . . . . . . . . . . . . . .
Bar 2
Bass drum   X . . . x . . . X . . . x . . .
Lead drum   . . . . . . . . . . . . . . . .
Cowbell     x . x x . x . x x . x x . x . x
Whistle     X . x . X . x . X x X . . . . .
```

Notes: if the drummers say the feel is triplet/12-per-bar, reinterpret the same grid with 12 steps per bar (3 per beat) and re-enter. Store patterns as JSON (`{steps, swing, tracks:{name:[0..3]}}`) so the drummers can edit and you can ship their versions without code changes.

## 4. Sound sources

### 4a. Samples
- Reachability from this sandbox (HEAD): freesound.org 200, archive.org 200, unpkg 200, jsdelivr 301, npm registry 200. Freesound API returns 401 (needs token). Freesound **file download requires login** (page said "Login to download"; download URL redirects to login). Previews (`cdn.freesound.org`) return a redirect, so previews may be fetchable but are low-quality MP3 and previews are not a licence to redistribute beyond the sound's CC terms.
- Found one CC0 item: "London Street Drummers" by Alcappuccino, https://freesound.org/s/263662, CC0, cajon plus cowbells, but it is **street percussion in a noisy room, not Junkanoo**; not suitable as the groove.
- I found **no Junkanoo-specific or goatskin-goombay CC0/CC-BY sample**. A real goatskin-drum sample would need to be recorded (see section 5) or licensed from Bahamian drummers with written permission.
- Practical procedure if you want samples: a human with a Freesound account filters CC0/CC-BY for "cowbell", "whistle", "djembe/goatskin", downloads, records the attribution (CC-BY requires credit), and commits the files into `public/samples/` with a `CREDITS` file. I could not do the logged-in download here.

### 4b. Synthesis in WebAudio (recommended default; no licensing, tiny, tempo-exact)
These are standard techniques; I have not auditioned them against Junkanoo drums.
- **Goatskin/goombay drum (low and lead):** sine oscillator with pitch envelope (e.g. 160 Hz down to 90 Hz in about 60 ms for bass; 300 to 200 Hz for lead), amplitude decay 120 to 250 ms, plus a 10 to 20 ms band-passed noise burst for the slap. Add a "heated skin" brightness control (raise base pitch).
- **Cowbell:** two square oscillators near 540 Hz and 800 Hz (the 808 recipe), through a band-pass near 2.6 kHz, fast exponential decay 80 to 300 ms. Real Junkanoo bells have clappers and are harsher; add short noise rattle and detune slightly.
- **Whistle:** sine/triangle near 2.5 to 3.5 kHz with fast attack, small vibrato/noise, 60 to 250 ms notes.
- **Horn/foghorn:** sawtooth about 110 Hz through low-pass; optional.
- Everything is scheduled with `AudioContext.currentTime` look-ahead as the app already does.

## 5. Fallback: record the user's own drummers

Feasible in browser. Flow: `getUserMedia` (turn off echoCancellation/noiseSuppression/autoGainControl for music) then `MediaRecorder` or AudioWorklet capture, 1 to 4 bars, decode to `AudioBuffer`, detect tempo, let the user confirm/tap the downbeat, then loop at chosen BPM.

Libraries (checked on the npm registry on 2026-11-25; sizes are unpacked package size, not gzipped bundle):

| Need | Library | Licence | Size | Comment |
|---|---|---|---|---|
| Tempo detect (offline buffer) | `web-audio-beat-detector` 8.2.x | MIT | about 42 KB | Gives BPM and optional offset (first-beat position), fine for a short loop. |
| Tempo detect (live mic) | `realtime-bpm-analyzer` 6.3 | Apache-2.0 | about 558 KB | AudioWorklet, works with mic. |
| Time-stretch, simple | `soundtouchjs` 0.3 | **LGPL-2.1** | about 1.9 MB unpacked | Fine for a web app if linked as a separate module (LGPL obligations: allow replacing the library, keep notices). Quality is okay for small ratios, can smear transients. |
| Time-stretch, best quality | `rubberband-web` 0.2 (Rubber Band WASM AudioWorklet) | **GPL-2.0-or-later** (Rubber Band also sold under commercial licence by Breakfast Quay) | about 1.5 MB | Better with percussion (transient mode), but GPL would force the app to GPL unless a commercial licence is bought. Avoid unless that is acceptable. |
| Analysis | `essentia.js` | AGPL-3.0 | about 10 MB | Overkill and AGPL; avoid. |

Recommendation for the fallback:
1. **Avoid stretching where possible.** Use `AudioBufferSourceNode.playbackRate` for loops when the user is happy with pitch shifting by small ratios (about +/-8%); for drums this sounds natural, like speeding tape. Cost: zero dependencies, zero licence risk.
2. If larger ratios are needed, use **slicing instead of stretching**: detect onsets, cut the loop into hits, and re-trigger each hit at its new grid position (beat-slicing, like ReCycle). This preserves the drummers' real timbre exactly and is the most authentic for percussion. Implement with simple energy-flux onset detection (about 60 lines) plus a quantise-strength slider (0 to 100%) so the human feel is kept.
3. Use `web-audio-beat-detector` (MIT) for the BPM guess, always with a manual "tap tempo" / "drag the bar line" override. Auto downbeat detection on a short drum loop is unreliable; make the user mark beat 1.
4. Keep `soundtouchjs` as an optional later add only if slicing proves insufficient (LGPL, load lazily).
5. Rights: get permission from the drummers to record, and store loops client-side (IndexedDB) by default.

## 6. Recommended plan

1. Build a 16-step (or 12-step) sequencer UI with per-track mute, volume, swing/triplet toggle, BPM. Ship Patterns A to C as editable presets labelled "starter, unverified".
2. Synthesize sounds (4b). Time-box tuning; ask the brass player to judge which sounds are acceptable.
3. Session with real drummers: record each part individually (bass, lead, cowbell, whistle) and the full group. Use this to (a) correct the patterns, (b) harvest one-shot samples (with written permission and credit), (c) test the record-loop fallback.
4. Add the loop recorder with slicing-based tempo conformance.

## 7. Sources

- N. Bethel, "On Sousaphones, Junkanoo, and Emancipation" (2007): https://nicobethel.com/nicobethel-blogworld-2/2007/01/14/on-sousaphones-junkanoo-and-emancipation (fetched; lead drum/additional drums/cowbell/whistle, brass history)
- Nassau Guardian, "Junkanoo explained": https://nassauguardian.net/culture/junkanoo-explained-rush-costumes-groups (fetched; roles of drums, cowbells, whistles, brass; judging)
- Tribune, "Junka time is here" (2012): https://www.tribune242.com/news/2012/apr/11/junka-time-is-here-the-evolution-of-the-junkanoo/ (fetched; time signatures "held firm", none stated)
- Wikipedia Junkanoo: https://en.wikipedia.org/wiki/Junkanoo ; Music of the Bahamas: https://en.wikipedia.org/wiki/Music_of_the_Bahamas ; Goombay: https://en.wikipedia.org/wiki/Goombay (search-snippet level)
- Museum of Miami, Caribbean percussion traditions: https://museumofmiami.org/south-florida-folklife-center/highlighted-projects/caribbean-percussion-traditions-in-miami/ (snippet: cowbells in pairs)
- Melodigging Junkanoo (production guide, weak): https://www.melodigging.com/genre/junkanoo
- Afropop, Bahamas Junkanoo carnival: https://afropop.org/articles/bahamas-junkanoo-carnival (snippet)
- Smithsonian Folklife 1994 programme book (not text-extractable by me, unverified): https://folklife-media.si.edu/docs/festival/program-book-articles/FESTBK1994_32.pdf
- Leads not checked (best next reading): E. Clement Bethel, *Junkanoo: Festival of the Bahamas* and his MA thesis "Music in The Bahamas: its Roots, Rhyme and Personality"; Junkanoo Cultural Museum (Nassau); College of the Bahamas journal articles (https://cob.journals.publicknowledgeproject.org/index.php/files/article/view/189/241 returned HTTP 502 for me).
- Freesound CC0 item: https://freesound.org/s/263662 ; npm registry metadata for the libraries listed above.
- Not found despite searching: any YouTube lesson titled with a Junkanoo pattern in words, any BPM data, any named beats.
