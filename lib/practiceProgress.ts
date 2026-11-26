export const PRACTICE_SAMPLE_ID = 'practice-sample';
const LAST_SCORE = 'brass-reader:last-practiced';
const progressKey = (id: string) => `brass-reader:practice:${id}`;

export function lastPracticedId(): string | null {
  try { return localStorage.getItem(LAST_SCORE); } catch { return null; }
}

export function readPracticeProgress(id: string): { measure: number; label: string } | null {
  try {
    const progress = JSON.parse(localStorage.getItem(progressKey(id)) ?? 'null');
    if (Number.isSafeInteger(progress?.measure) && progress.measure >= 1 && typeof progress.label === 'string') return progress;
  } catch { /* Storage may be disabled. */ }
  return null;
}

export function practiceBar(id: string): string {
  const { label } = readPracticeProgress(id) ?? { label: '1' };
  return label === 'Pickup' ? label : `Bar ${label}`;
}

export function rememberPractice(id: string, measure: number, label: string): void {
  if (id === PRACTICE_SAMPLE_ID) return;
  try {
    localStorage.setItem(progressKey(id), JSON.stringify({ measure, label }));
    localStorage.setItem(LAST_SCORE, id);
  } catch { /* The current practice session still works. */ }
}
