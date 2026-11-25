import { INSTRUMENTS, type InstrumentId } from './instruments';

export const DEFAULT_OMR_MODEL = 'claude-sonnet-5-5';

/** Reply the reader gives when the picture is not sheet music at all. */
export const NOT_MUSIC = 'NOT_MUSIC';

/** The worked example inside the prompt (unit-tested: it parses cleanly and every bar adds up). */
export const OMR_EXAMPLE = `title: Example March
part: Trumpet in Bb
clef: treble
key: 2b
time: 4/4
tempo: 112
# page 1 system 1
0: F4:q
1: |: B4:q D5:e C5:e B4:h
2: En5:q. D5:e C5:h~
3: C5:q r:q r:h [1 :|
4: [2 B4:w ]
# page 1 system 2
5-8: R
9: key=1b time=3/4 A4:e/3 B4:e/3 C5:e/3 D5:h
10: segno F4+A4:h. fine
? 2: the sign in front of the first note could be a natural or a sharp`;

export const OMR_SYSTEM_PROMPT = `You read photographs and scans of sheet music for brass players and write down exactly what is printed, in the compact text format described below. A program turns your text into a score, checks that every bar adds up, and a musician then plays along with it at rehearsal. A wrong pitch, a missed dot or a dropped bar is heard straight away, so accuracy matters far more than speed: look closely, note by note, before you write.

# The format

Reply with plain text only: header lines, then one line per bar. No explanations and no markdown.

Header, once per part, before its bars:
title: the title printed on the page (leave the line out if there is none)
part: the instrument name printed at the staff (leave out if none)
clef: treble, bass, tenor, alto, or treble8vb (treble clef with a small 8 below it)
key: how many sharps or flats are in the key signature: 2b, 3#, or 0 for none
time: 4/4, 3/4, 6/8, 2/2 and so on. Write C for the common-time sign and cut for the cut-time sign.
tempo: the number, only if a metronome mark is printed

Bars: the bar number, a colon, then the contents separated by spaces.

- A note is pitch, colon, value. C5:q is a quarter note on C in octave 5.
  - Pitch: the letter A to G, then an accidental only if a sign is printed directly in front of that note (# sharp, b flat, n natural, x double sharp, bb double flat), then the octave number. Middle C is C4.
    Write what is printed and nothing more. Do not apply the key signature yourself and do not repeat an accidental that is not printed again: the program applies the key signature and carries an accidental to the end of its bar, the same way a player reads it. With two flats in the key, a note on the middle line of the treble staff is written B4, and it will be played as B flat.
  - Value: w whole, h half, q quarter, e eighth, s sixteenth, t thirty-second. Add one . per dot (q. or h..). Triplets: add /3 to every note of the group (e/3 e/3 e/3). Other groups: /5 /6 /7, and /2 for a duplet in 6/8.
  - ~ after the value means the note is tied to the next note of the same pitch (C5:h~ C5:q). A curve joining different pitches is a slur: leave it out.
  - Rest: r and a value (r:q). A bar that is rest from start to end: R
  - Notes that share a stem: join them with + (C4+E4+G4:q).
  - Grace note: value g (D5:g). It does not count toward the bar.
- Multi-bar rest (a thick horizontal bar with a number above it): one line with the range it covers, for example "17-24: R" for eight bars of rest.
- Repeat signs: |: at the bar where a repeat begins and :| at the bar where it ends (:|x3 if it is marked to be played three times).
- Endings (numbered brackets above the staff): [1 in the first bar under bracket 1, [2 in the first bar under bracket 2, and ] after the last bar under the final bracket.
- Signs and jumps, in the bar where they are printed: segno, coda, tocoda, fine, dc, dc.fine, dc.coda, ds, ds.fine, ds.coda
- A change of key, time or clef during the piece goes at the start of the bar where it happens: key=1# time=3/4 clef=bass
- Lines that start with # are comments. Start every line of music on the page (every system) with one, like "# page 1 system 3". It keeps your place.
- When something is truly doubtful (a smudge, a cut-off edge, unclear handwriting), still write your best reading in the bar, and add a line after the bars: "? 12: could be A4 or B4, the note head is smudged". The player is shown these as bars to check, so use them for real doubt only.

Bar numbers: the first full bar is 1. An incomplete first bar (pickup) is 0. Count every bar. If bar numbers are printed on the page, yours must agree with them. Never leave out or merge bars: if a bar is hard to read, write your best reading and add a ? line.

Example:
${OMR_EXAMPLE}

# Reading the page

- Work through the systems from top to bottom and each system from left to right. Find the clef, then count the sharps or flats of the key signature (it is printed again at the start of every system), then the time signature.
- Pitch comes from the position of the note head. Treble clef: the lines from the bottom are E4 G4 B4 D5 F5, the spaces F4 A4 C5 E5; middle C (C4) sits on the first ledger line below the staff and A5 on the first ledger line above. Bass clef: lines G2 B2 D3 F3 A3, spaces A2 C3 E3 G3; middle C (C4) sits on the first ledger line above the staff and E2 on the first ledger line below. Count ledger lines one by one.
- Rhythm: after each bar, add up the values. They must equal the time signature. The only exceptions are a pickup bar and the bar that completes it (usually the last bar, or the bar before a repeat sign). If a bar does not add up, look again before moving on: the usual causes are a missed dot, a short rest, the number of beams or flags, or a tie.
- Photographs are often tilted, curved, shadowed or creased. Follow the staff lines, not the edges of the picture.
- Only the notes matter. Leave out lyrics, chord symbols, fingerings, dynamics, articulation marks, slurs, rehearsal letters and other text.
- Several images are consecutive pages of one piece, in order (each image is labelled). When a page is given as a top part and a bottom part, they follow each other and do not overlap. Bar numbers continue across images, and the clef, key and time stay in force until the page shows a change.
- If a system has several staves (a score or a duet) and you were not asked for one particular part, write each staff as its own part: the header and all bars of the first part, then a new "part:" header and all bars of the next. Every part uses the same bar numbers.
- If the picture is not sheet music, reply with ${NOT_MUSIC} and one short sentence saying what it shows.`;

export interface OmrHints {
  /** What the player says the music is written for. */
  instrument?: InstrumentId;
  /** Name of the one part to read on a page with several staves. */
  part?: string;
}

/** Keep only harmless characters of a free-text hint (it is quoted inside the prompt). */
export function cleanPartHint(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[^\p{L}\p{N} #.♭♯-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * Labels for the images: one label per image. `tiles[i]` = how many images page i was cut into (1 = whole page,
 * 2 = top and bottom). Without `tiles` every image is one page.
 */
export function pageLabels(imageCount: number, tiles?: number[]): string[] {
  const t = tiles && tiles.reduce((a, b) => a + b, 0) === imageCount ? tiles : Array(imageCount).fill(1);
  const out: string[] = [];
  t.forEach((n: number, i: number) => {
    const page = t.length > 1 ? `Page ${i + 1} of ${t.length}` : 'The page';
    if (n === 1) out.push(`${page}:`);
    else for (let k = 0; k < n; k++) out.push(`${page}, ${n === 2 ? (k === 0 ? 'top part' : 'bottom part') : `part ${k + 1} of ${n} from the top`}:`);
  });
  return out;
}

export function userPrompt(pageCount: number, hints: OmrHints = {}): string {
  const lines: string[] = [];
  lines.push(pageCount > 1
    ? `These are ${pageCount} consecutive pages of one piece. Read all of them into one transcription with continuous bar numbers.`
    : 'Read this sheet music into the text format, exactly as printed.');
  if (hints.instrument && INSTRUMENTS[hints.instrument]) {
    const inst = INSTRUMENTS[hints.instrument];
    lines.push(`The player says this music is written for ${inst.name}, which normally reads ${inst.clef} clef. Use that only to settle doubt: if the page clearly shows something else, write what the page shows.`);
  }
  const part = cleanPartHint(hints.part);
  if (part) {
    lines.push(`The page may show several instruments. The player only needs the part for "${part}": read just that staff. If no staff carries that name, read every staff as a separate part.`);
  }
  lines.push('Check that every bar adds up before you answer, and reply with the transcription only.');
  return lines.join('\n');
}

export interface BarProblem {
  /** Part name, when there is more than one part. */
  part?: string;
  label: string;
  /** The bar as it was read. */
  raw?: string;
  /** What is wrong, e.g. "adds up to 3 quarter notes, the time signature needs 4". */
  what: string;
}

/** Second look at specific bars: the reply carries only the corrected lines. */
export function fixBarsPrompt(previous: string, problems: BarProblem[]): string {
  const list = problems.slice(0, 40).map((p) => `- ${p.part ? `${p.part}, ` : ''}bar ${p.label}${p.raw ? ` (read as: ${p.raw})` : ''}: ${p.what}`).join('\n');
  return `You read these pages a moment ago. This was your reading:
<reading>
${previous}
</reading>

A check found bars that cannot be right:
${list}

Look at each of those bars in the image again, note by note: values, dots, rests, ties, beams and flags, and whether a bar line was missed or added. Reply with only the corrected bar lines in the same format, one line per bar (for example "7: C5:q D5:q E5:h"), and nothing else. If the reading has several parts, put each corrected line under its "part:" line.
If a bar really is as you wrote it because the time signature changes there, write it again with the change (time=3/4). If most bars are off in the same way, the time signature in the header is probably wrong: send a corrected "time:" line as well.`;
}

/** Full second attempt after a reply that could not be used at all. */
export function retryPrompt(error: string): string {
  return `Your previous reply could not be used: ${error}\nRead the page again and reply in the text format only: header lines, then one line per bar (for example "1: C5:q D5:q E5:h").`;
}

/** Pull a MusicXML document out of a reply (kept for readers that answer in MusicXML). */
export function extractXml(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:xml|musicxml)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].includes('<score-partwise')) t = fence[1].trim();
  const start = t.indexOf('<?xml') >= 0 && t.indexOf('<?xml') < t.indexOf('<score-partwise')
    ? t.indexOf('<?xml')
    : t.indexOf('<score-partwise');
  const endTag = '</score-partwise>';
  const end = t.lastIndexOf(endTag);
  if (start < 0 || end < 0) return t;
  return t.slice(start, end + endTag.length);
}
