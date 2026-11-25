# QA: Phase 2 + Drums, mobile UX and musical correctness

Tester: QA agent 4. App source and git were not touched. Throwaway files and screenshots are in
`/tmp/claude-0/-home-user-Main-chat/8c0f9322-8acb-5fb5-bd40-10249832903a/scratchpad/qa4/` (`shots/`, `m-*.png` contact sheets, `*.js` drivers).

How it was run: Chromium with the iPhone 13 and Pixel 7 descriptors (portrait and landscape), plus 320x568 and 568x320 "small phone", dark and light, deviceScaleFactor 1.
`npx next dev -p 3400` refused to start ("Another next dev server is already running", the project lock is held by the dev server on port 3100), so everything ran against the existing dev server on `localhost:3100`. Fake mic: Chromium's built-in beep device.
Test score: 16-bar two-part tune (trumpet treble plus trombone bass) generated in the scratchpad.
NOT tested (no way to here): real audio quality, real mic, real iOS Safari (Chromium only), listening to the kit.

## Summary

- P0: none found.
- P1: 5 (global Space key hijack; drawer unusable in landscape; Loop section hidden below the fold and drawer hides the score; drawer/studio are not real dialogs for keyboard and screen readers; drums checkbox label clipped).
- P2: 12. Music data: no wrong trumpet, mellophone, baritone or trombone primary fingering found; sousaphone chart/range stops too low (F3).

---

## P1

### P1-1. Space bar is hijacked on every button, summary and step cell (keyboard / switch / external keyboard users)
Repro (desktop width, keyboard): open Practice, Tab to a section header (`summary`) and press Space. The section does NOT open and the music starts instead. Same for the "Loop these bars" button (nothing is looped, playback starts), and for a step cell in the Step pattern editor (Space does not toggle the step, playback starts under the editor; Enter and the `a`/`s` keys do work).
Cause: the window keydown handler only ignores INPUT, SELECT, TEXTAREA and contentEditable; BUTTON, SUMMARY and A are not excluded, and it calls `preventDefault()` so the native activation is cancelled.
File: `app/score/[id]/page.tsx` (the `onKey` effect, around the "typing / toggling in a form control" comment). Fix: also skip when the target is a button, summary, a, `[role=button]`, or inside `.sheet` / `.studio`, or only handle Space when focus is on body/the score.
Also: the same handler lets ArrowLeft/ArrowRight change bars while the studio is open (a drummer pressing arrows in the editor moves the score).

### P1-2. Practice drawer is nearly unusable in landscape
Measured visible height of the scrolling body (`.sheet-body`) with the drawer open:
- iPhone 13 landscape: 152 px (about 2.5 section headers); Pixel 7 landscape: 168 px; 320x568 portrait: 297 px; 568x320 landscape: 82 px (one header, rest hidden behind the transport).
- Portrait iPhone 13: 357 px of 664 (54%).
Cause: `.sheet` bottom is pinned to `--transport-h` and the title row ("Practice" and a 48 px close button) uses about 60 px; the transport is a fixed 65 to 135 px bar.
A trumpet player holding the phone sideways on a stand gets a 1.5-line window. Screenshots: `m-land.png`, `m-sm.png`.
File: `app/globals.css` (`.sheet`, `.sheet-head`), `components/PracticeSheet.tsx`. Ideas: in landscape put the drawer as a right-hand side panel (about 45% width, full height, transport stays under the score), merge the title and close button into one slim row, or hide the transport's second row while the drawer is open.

### P1-3. The Loop and speed trainer section (the main feature) is the last section, below the fold, and the open drawer covers the score
- Section order is Band, Range, Fingerings, Pitch check, Record, Drums, Loop. Loop has `open` set but on every phone size tested (including iPhone 13 portrait) it is below the fold when the drawer opens (`iph-p-dark-02-drawer-default.png` shows six collapsed headers, no Loop). Most players will never scroll to it.
- Sections are independent `<details>` (not an accordion), so opening two or three pushes everything away.
- With the drawer open on a 390x664 phone only about 100 px of score is visible above it, so you cannot pick bars or see the loop shading, and you cannot see Fingerings or Range marks you just switched on.
- The drawer button is a plain "repeat" arrow icon with no text. A player looking for "speed trainer", "pitch check" or "record" has no clue the tools are behind a loop icon (aria-label is "Practice", but sighted users get only the arrows).
Files: `app/score/[id]/page.tsx` (section order), `components/PracticeSheet.tsx` (accordion), top bar button (`.practice-btn`, `LoopIcon`). Ideas: put Loop first, make the drawer an accordion with one open at a time, give the top-bar button the word "Practice" (or a "Practice" label under the icon), allow collapsing the drawer to a half-height peek so the score stays in view.

### P1-4. Drawer and Grooves studio are not real dialogs (keyboard, screen reader)
- Opening the drawer with Enter leaves focus on the top-bar Practice button. The next Tabs go through zoom, both instrument selects, Part, Mute, "No sound?", Download MIDI and Download MusicXML (9 stops) before reaching "Close practice tools" and the first section. Focus order is: whole page first, drawer last.
- No Escape handling anywhere (`grep Escape` finds nothing in app, components, lib): Escape does not close the drawer or the studio.
- No focus trap and no `inert`/`aria-hidden` on the page behind. In the full-screen studio, Tab moves from the studio into the background ("Loop and speed trainer" summary was the next stop after "Grooves…"). `role="dialog"` has no `aria-modal`.
- Opening the studio does not move focus into it (focus stays on the hidden "Grooves…" button); closing it does not return focus.
- Practice button has `aria-expanded` but no `aria-controls`.
Files: `components/PracticeSheet.tsx`, `components/GrooveStudio.tsx`. Fix: move focus to the dialog heading on open and return it on close, Escape handler, put the drawer before the transport but after nothing else in tab order (or `inert` the main page while the studio is open).

### P1-5. Text clipped in the Drums section (label cut off, no wrap)
"Keep the drums while recording and in take replays" overflows its box by 36 px at 390 wide and 76 px at 320 wide (scrollWidth 366 vs clientWidth 330; 336 vs 260). The text is cut at the right edge (`m-iph-b.png`, last tile, shows "...take replay"). The drum section row is `.chk.wide` with `white-space: nowrap`.
Also inside the same section, the Groove select shows the long option "Starter A · Pulse (starter, not traditional)" at the same width (does not clip, select truncates, but the useful word "Pulse" is all that fits on a small phone).
File: `app/globals.css` (`.chk`, `.chk.wide`), `components/DrumsPanel.tsx`. Fix: `white-space: normal` for `.chk.wide`, shorter copy ("Keep drums while recording").

---

## P2

### UX / layout
- P2-1 Long-press loop selection is not discoverable. The only hint is in the drawer's Loop section (one grey line), and nothing is on the score. Holding a bar gives no feedback during the 500 ms hold (no ring, no vibration), and after it fires nothing says "Looping bar 3" (`lp.js`: no hint text on the main page; the transport does not mention a loop until you press Play, then "Pass n"). File: `components/ScoreView.tsx` (`onPointerDown`), `app/globals.css` (`.loop-mark`). Ideas: first-use toast "Tip: press and hold a bar to loop it", a growing ring during the hold, `navigator.vibrate(15)` on fire, and a "Loop bars 3 to 3 [x]" chip above the transport with a clear button.
- P2-2 Loop overlay (`.loop-mark`, grey-blue, 20% opacity) is hard to tell from the orange cursor highlight on the same bar (`m-lp.png`: dark and light). A one-bar loop on the current bar looks like only the cursor. Use a dashed border, a bracket or a label "Loop".
- P2-3 Long-press during a phone scroll: the page can scroll while the finger is down (light screenshot `lp-light-1.png` moved the score); the 10 px cancel is correct, but there is no visible difference between "I scrolled" and "I started a loop".
- P2-4 Small touch targets (under 48 px): "make this my part" link 134x34, "Detected 120 BPM" link 139x34, "No sound?" 69x32, bar-count buttons 1/2/4 in the groove review (36, 39, 40 px wide x 48), "1"/"2" bar buttons in the step editor (36x48, 39x48), and the step cells on a 320 px phone (32x48 for 16-step rows; 41 px wide at 390). Add `min-width: 48px` to `.btn.sm`.
- P2-5 Step editor reads OK but could be clearer (`m-s2.png`): 16 steps wrap into two rows of 8 with no beat numbers (1 2 3 4), the only hint of the beat grid is a slightly lighter border on every 4th cell; the "soft" state exists (v1) but can only be set with the `s` key on a keyboard, there is no touch way and no on-screen legend of empty / soft / on / accent; accent is a thin ring that is easy to miss; "Hear the pattern" and Tempo sit below all four rows (scroll needed each time you edit); no moving playhead while it plays. In the light theme empty cells are near-white on cream and barely visible (`m-s5.png`, last tile). Files: `components/KitEditor.tsx`, `app/globals.css` (`.cell`).
- P2-6 Starter labels are visible and clear everywhere: "Starter pattern — not a traditional rhythm. Fix it by ear." appears at the top of the starter list, in the Drums section when a starter is chosen, and in the editor; the dropdown says "(starter, not traditional)". Fine. Minor: on the studio list the header "Starter patterns" and the dashed note repeat each other, and "Your grooves" (the thing a drummer actually made) is below three starter cards, so a band with 5 recorded grooves must scroll past starters first. Put "Your grooves" first once it has items.
- P2-7 Recorder flow: record, count-in, stop, review, tempo fix, save works and is readable (`m-s3.png`), but the stages are not labelled as steps. After Stop the player lands on a long page: waveform, downbeat, tempo, bars, quantize, snap, "Hear the loop", name, Save. "Hear the loop" is below the tempo controls, so fixing the tempo and checking by ear means scrolling back and forth. A sticky "Hear the loop / Save groove" bar and a one-line "1 Record 2 Check tempo and downbeat 3 Save" would help. "Quantize" and "Snap to" are jargon: "Tighten the timing 0% (as played) to 100% (perfect grid)" is clearer. The recorder text also says "Record one to four bars... or more: you choose the loop next", which reads like a riddle.
- P2-8 Groove file export/import: buttons say "Export" (per groove) and "Import a groove file", plus the hint "Export one to send it to the band: the file holds the recording too". Understandable, but "Export" only downloads a `.groove.json` and nothing says where it went or how to send it from a phone (Share sheet). Consider `navigator.share({files})` where available, and name the file extension in the import button. The review "Discard" button also lacks a confirm after a 20 s recording.
- P2-9 Pitch check "Hearing Bb3 +5" shows the concert (sounding) note name. A trumpet player reading written C4 sees "Hearing Bb3" which looks like a wrong note. For transposing instruments show the written name (and keep concert in a title). File: `components/PitchPanel.tsx` and `noteLabel` in `lib/pitchMic.ts`. The judging itself is correct (see Music below).
- P2-10 After a speed-trainer run the transport BPM box stays at the last trainer tempo (`p.onPass` calls `setBpm(b)`), so the player's own tempo is lost until reload. Show the trainer tempo separately or restore the base BPM on stop. File: `app/score/[id]/page.tsx`.
- P2-11 Dark and light themes both work; no overflow of the page itself at 320/375/390/412 wide (all `docOverflow: false`). Contrast of grey helper text (`--muted`) on the drawer panel is low in the light theme for 0.85 rem text.
- P2-12 Drawer scrolls (overflow-y auto, `overscroll-behavior: contain`) and nothing on the page scrolls horizontally. Good.

### Music data
- P2-13 Sousaphone range and chart are too small: `INSTRUMENTS.sousaphone.writtenRange` is E1 to F3 (28 to 53) and the chart in `lib/fingering.ts` has open harmonics only up to F3 (`partials: [34, 41, 46, 50, 53]`, `high: 53`). Marching sousaphone parts routinely go to Bb3 (and C4). Result: F#3, G3, Ab3, A3, Bb3 show "—" for fingering and are flagged out of range (red range marks) although they are normal notes (F#3 = 2-3, G3 = 1-2, Ab3 = 1, A3 = 2, Bb3 = 0 from the 8th harmonic Bb3 = 58). Add 58 to `partials` and raise `high` / `writtenRange` to 58 (or 60). Files: `lib/fingering.ts`, `lib/instruments.ts`.

---

## Music correctness (item 2)

Method: generated every note from `fingeringFor()` for every instrument (`fing.ts` in the scratchpad) and compared with the standard charts.

### Bb trumpet (written C4 to C6, chart F#3 to C6): primaries all correct
F#3 1-2-3, G3 1-3, Ab3 2-3, A3 1-2, Bb3 1, B3 2, C4 0, C#4 1-2-3, D4 1-3, Eb4 2-3, E4 1-2, F4 1, F#4 2, G4 0, Ab4 2-3, A4 1-2, Bb4 1, B4 2, C5 0, C#5 1-2, D5 1, Eb5 2, E5 0, F5 1, F#5 2, G5 0, Ab5 2-3, A5 1-2, Bb5 1, B5 2, C6 0. No wrong primary. C#4 and D4 (and the other low notes) correctly have no "3" alternate (the third valve alone is only offered where a 1-2 primary exists: A3, E4, A4, C#5), so the "3 for 1-2" substitute is applied correctly and nowhere else.
Not wrong but questionable alternates for a brass teacher to prune (they are mechanical "other open harmonic within 6 semitones", many are badly out of tune and nobody teaches them): G4 [1-3], B4 [1-3], D5 [1-3], G5 [1-3], E5 [1-2], C5 [2-3], F#4 / F#5 / Bb4 / C#5 [1-2-3], Eb5 [2-3]. Missing standard alternates: none important (low G3 etc. have none, correct). The chart stops at C6 (nothing for C#6 to F6) which matches the plan.

### Mellophone in F
Uses the trumpet chart on the written pitch. Written to concert is -7 (down a fifth), key signature fifths -1: correct. Verified end to end: trumpet part written C4 loaded to mellophone sounds Bb3 and gets fingering "1" (written F4), and a mellophone part written C4 sounds F3 and gets "0". Correct.

### 3-valve baritone (bass clef, concert, non-compensating, E2 to Bb4)
All primaries correct (E2 1-2-3, F2 1-3, F#2 2-3, G2 1-2, Ab2 1, A2 2, Bb2 0, B2 1-2-3, C3 1-3, C#3 2-3, D3 1-2 [alt 3], Eb3 1, E3 2, F3 0, F#3 2-3, G3 1-2, Ab3 1, A3 2, Bb3 0, B3 1-2, C4 1, C#4 2, D4 0, Eb4 1, E4 2, F4 0, F#4 2-3, G4 1-2, Ab4 1, A4 2, Bb4 0). No wrong entry. Note the same remark about rarely used alternates (E3 [1-2-3], Ab3 [1-2-3], A3 [1-3], etc.).
Gap, not wrong: B4 and above show "—" (range stops at Bb4). Pedal notes below E2 show "—" (reasonable for non-compensating).

### Trombone (positions 1 to 7, E2 to Bb4)
All primaries correct (E2 7, F2 6, F#2 5, G2 4, Ab2 3, A2 2, Bb2 1, B2 7, C3 6, C#3 5, D3 4, Eb3 3, E3 2, F3 1, F#3 5, G3 4, Ab3 3, A3 2, Bb3 1, B3 4, C4 3, C#4 2, D4 1, Eb4 3, E4 2, F4 1, F#4 5, G4 4, Ab4 3, A4 2, Bb4 1).
Alternates correct and mechanically right: F3 also 6th, Bb3 also 5th, C4 also 6th, C#4 also 5th, D4 also 4th, E3 also 7th, A3 also 6th, Ab3 also 7th, B3 also 7th, E4 also 7th, F4 also 6th. Both examples from the brief (F in 6th, Bb in 5th) are present. No wrong entries.
Notes: F#4 only shows 5th; many players use 2nd on the F#4 7th partial or 4th on the... none of that is "wrong". The chart stops at Bb4 while trombone parts commonly go to F5; those show "—". Nothing for the pedal Bb1.

### BBb sousaphone
All primaries in E1 to F3 are correct (E1 1-2-3, F1 1-3, F#1 2-3, G1 1-2, Ab1 1, A1 2, Bb1 0, B1 1-2-3, C2 1-3, C#2 2-3, D2 1-2, Eb2 1, E2 2, F2 0, F#2 2-3, G2 1-2, Ab2 1, A2 2, Bb2 0, B2 1-2, C3 1, C#3 2, D3 0, Eb3 1, E3 2, F3 0). Wrong: only the missing top (see P2-13). E3 and F3 have no alternates (correct for this algorithm).

### Range limits (`INSTRUMENTS[].writtenRange`)
Trumpet 54 to 84 = F#3 to C6, mellophone same written range, baritone and trombone E2 to Bb4, sousaphone E1 to F3. All are in WRITTEN pitch, and `outOfRange` converts sounding to written correctly (`writtenMidi`). Only the sousaphone top is questionable (P2-13); a trombone top of Bb4 and baritone top of Bb4 are on the conservative ("comfortable") side but defensible. Range panel text "Bb Trumpet (F#3 to C6)" is correct.

### Speed trainer math (`lib/loop.ts`)
`trainerBpm(t, pass)` = start + dir x floor((pass-1)/every) x step, never beyond target, clamped to 30 to 240, works counting down when target < start. With the defaults (start 70, target 120, +5 every 1 pass) pass 1 to 11 gives 70, 75, 80, ... 120, then stays at 120. With every = 3: passes 1 to 3 at 70, 4 to 6 at 75. Correct. `normalizeTrainer` keeps step 1 to 60 and every 1 to 32. The player applies the first-pass tempo at Play and steps on the wrap. Only note: the plan's example "Pass 3 · 85 → 120" would need start 75; the label code itself is right (`Pass 3 · 80 → 120 BPM` with defaults).

### Pitch check judging (transposing instruments)
Expected pitch comes from `tlNow.events` which are SOUNDING (concert) midi (built from the transposed XML, `midi: base + transpose`). Verified end to end with `tl.ts`: trumpet written C4 gives 58 (Bb3), mellophone F written C4 gives 53 (F3), trombone and sousaphone use concert as written. The mic detects sounding pitch, so the judging is correct for trumpet and mellophone. `judgeNote` thresholds (green 25 cents, yellow 50 cents, red beyond or fewer than 3 clear frames) match the plan; an octave error is red. Only the display issue P2-9 (concert name shown to a player who reads written pitch) is wrong for musicians. Concern, not testable here: sousaphone E1 (41 Hz) with a 4096-sample window and phone mics that roll off below about 100 Hz.

---

## Accessibility (item 4)

Good:
- Every new control has an accessible name (script found zero unnamed buttons, inputs, selects or summaries). Mute / Solo have `aria-pressed` and per-part labels; volume sliders are labelled; step cells have labels like "Bass drum step 2: empty" and `aria-pressed`; the level meter has `role="meter"`; the waveform has an `img` label with the downbeat time; live regions exist for the engine status, bar counter, recording state, align warnings and pitch summary.
- Step editor keyboard: Enter toggles, `a` sets accent, `s` soft.
- Focus rings are visible (3 px accent outline).

Needs work:
- P1-1 (Space hijack) and P1-4 (focus order, no Escape, no trap, studio not modal).
- The "Hearing ..." readout is `aria-live="off"` (fine, it changes 30x a second) but the pitch-check results (green/yellow/red per note) are colour only, with arrows for sharp/flat; there is no text alternative per note (the summary line is the only text). Marks on the score are not reachable by a screen reader.
- The loop selection by long-press has no keyboard or screen-reader equivalent on the score itself (the number boxes in the drawer are the alternative, which is good), and the loop mark has no label.
- Practice button: `aria-expanded` but no `aria-controls`; the sheet stays mounted and hidden with the `hidden` attribute (correct, not focusable while closed).
- The waveform downbeat marker can only be moved by pointer (the -10 ms / +10 ms buttons are the keyboard alternative, good).

---

## Prioritised UX polish ideas

1. Fix the Space-key hijack (P1-1). Ten-minute change, big keyboard win.
2. Landscape drawer layout: side panel or merged header and hide transport row 2 (P1-2).
3. Put Loop and speed trainer first in the drawer, accordion behaviour, and put the word "Practice" on the top-bar button (P1-3).
4. Half-height "peek" drawer so the score stays visible while setting loops and fingerings.
5. Loop feedback: hold-ring plus vibration, "Loop 3 to 5 [x]" chip, a distinct dashed loop colour, and a first-use tip (P2-1, P2-2).
6. Wrap the long drum checkbox labels and shorten the copy (P1-5); min-width 48 px on `.btn.sm`, bigger link buttons (P2-4).
7. Step editor: beat numbers (1 2 3 4) over each group of four, a legend (empty / soft / on / accent) and a touch way to set soft, a sticky "Hear the pattern" bar with a moving playhead, stronger empty-cell borders in light theme (P2-5).
8. Recorder review: three-step header, sticky "Hear the loop / Save", plain words for Quantize and Snap to, confirm on Discard (P2-7).
9. Groove sharing: use the phone's Share sheet for Export; show a toast naming the saved file (P2-8).
10. Pitch check: show written note names for trumpet and mellophone players (P2-9); add the sousaphone top range to F#3 to Bb3 (P2-13).
11. Dialog accessibility: focus into the drawer/studio on open and back on close, Escape closes, `inert` background (P1-4).
12. Prune the mechanical fingering alternates to the ones a teacher would actually show (list in the trumpet section).
13. Restore the player's own tempo after a trainer run (P2-10); put "Your grooves" above the starter cards once any exist (P2-6).
