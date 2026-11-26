import { buildWindowXml } from './barWindow';
import { extractPart, kid, kidNum, kidText, kids, parseXml, partsOf, serializeXml, summariseScore, type XEl } from './musicxml';
import { parseTime } from './omrNotation';
import type { BarReadingContext } from './omrPrompt';
import { readFlow } from './timeline';

export function warningBar(warning: string): string | undefined {
  const label = /^(?:The )?(Pickup) bar\b|^Bar (\d+)\b/i.exec(warning);
  return label?.[1] ? 'Pickup' : label?.[2];
}

export function barsToReview(xml: string, part: number, labels: string[]): { label: string; measure: number }[] {
  const parts = partsOf(parseXml(xml));
  const bars = parts[part] ? kids(parts[part], 'measure') : [];
  return readFlow(parts).labels.flatMap((label, i) => i < bars.length && labels.includes(label) ? [{ label, measure: i + 1 }] : []);
}

export function reviewBarXml(xml: string, part: number, measure: number): string {
  return buildWindowXml(extractPart(xml, part), [measure]).xml;
}

export function barReadingContext(barXml: string): BarReadingContext | null {
  const [part] = summariseScore(barXml).parts;
  const time = part && parseTime(part.time);
  return part?.clef && part.fifths !== null && time
    ? { clef: part.clef, fifths: part.fifths, beats: time.beats, beatType: time.beatType }
    : null;
}

const complexBar = 'This bar contains a pickup, a cross-bar tie or a change within the bar. Review it against the original page.';

function duration(notes: XEl[]): number {
  return notes.reduce((sum, note) => sum + (kid(note, 'chord') || kid(note, 'grace') ? 0 : (kidNum(note, 'duration') ?? 0)), 0);
}

/** Replace only the selected measure's notes. Keep the original clef, key, repeats and navigation marks. */
export function replaceReviewedBar(xml: string, partIndex: number, measureIndex: number, reading: string): string {
  const doc = parseXml(xml);
  const part = partsOf(doc)[partIndex];
  const measures = part ? kids(part, 'measure') : [];
  const target = measures[measureIndex - 1];
  if (!target) throw new Error('That bar is unavailable.');
  const oldNotes = kids(target, 'note');
  const isolated = reviewBarXml(xml, partIndex, measureIndex);
  const isolatedMeasure = kids(partsOf(parseXml(isolated))[0], 'measure')[0];
  const retryDoc = parseXml(reading);
  const retryParts = partsOf(retryDoc);
  const retryMeasures = retryParts.length === 1 ? kids(retryParts[0], 'measure') : [];
  if (retryMeasures.length !== 1) throw new Error('The reader found more than one bar or staff. Select a smaller area.');
  const [replacement] = retryMeasures;
  const newNotes = kids(replacement, 'note');
  const before = barReadingContext(isolated);
  const after = barReadingContext(reading);
  if (!before || !after || before.clef !== after.clef || before.fifths !== after.fifths
    || before.beats !== after.beats || before.beatType !== after.beatType) throw new Error('The new reading changed the clef, key or time. Check the crop and try again.');

  const divisions = (bar: XEl) => {
    const attrs = kid(bar, 'attributes');
    return attrs ? (kidNum(attrs, 'divisions') ?? 1) : 1;
  };
  const originalDivisions = divisions(isolatedMeasure);
  const newDivisions = divisions(replacement);
  const fullLength = 4 * before.beats / before.beatType;
  const countTies = (bar: XEl) => bar.getElementsByTagName('tie').length;
  const countSlurs = (bar: XEl) => bar.getElementsByTagName('slur').length;
  const oldElements = kids(target);
  const oldStart = oldElements.indexOf(oldNotes[0]);
  const oldEnd = oldElements.indexOf(oldNotes.at(-1)!);
  if (!oldNotes.length || target.getAttribute('implicit') === 'yes' || target.getAttribute('number') === '0'
    || countTies(target) !== countTies(isolatedMeasure) || countSlurs(target) !== countSlurs(isolatedMeasure)
    || [...oldElements, ...kids(replacement)].some((el) => el.nodeName === 'backup' || el.nodeName === 'forward')
    || oldNotes.some((n) => kidText(n, 'voice') && kidText(n, 'voice') !== '1')
    || oldElements.slice(oldStart, oldEnd + 1).some((el) => el.nodeName !== 'note')
    || oldElements.slice(oldEnd + 1).some((el) => el.nodeName === 'attributes')
    || (measureIndex === 1 || measureIndex === measures.length) && duration(oldNotes) / originalDivisions < fullLength) throw new Error(complexBar);
  if (!newNotes.length || duration(newNotes) / newDivisions !== fullLength
    || newNotes.some((n) => kidText(n, 'voice') && kidText(n, 'voice') !== '1')) {
    throw new Error('The crop did not produce one complete bar. Include the full measure and try again.');
  }
  for (const note of newNotes) {
    const inserted = doc.importNode(note, true);
    const d = kid(inserted, 'duration');
    if (d) {
      const scaled = Number(d.textContent) * originalDivisions / newDivisions;
      if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error('The new rhythm cannot be written at this score’s resolution.');
      d.textContent = String(scaled);
    }
    target.insertBefore(inserted, oldNotes[0]);
  }
  for (const note of oldNotes) target.removeChild(note);
  return serializeXml(doc);
}
