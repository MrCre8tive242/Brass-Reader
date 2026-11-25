/** Small inline icons (drawn, not font glyphs: transport symbols turn into colour emoji on some phones). */
interface P { size?: number; className?: string }
const base = (size = 24) => ({ width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true as const, focusable: false as const });

export const PlayIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" /></svg>;
export const PauseIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="5.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" /><rect x="14" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" /></svg>;
export const PrevIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="4" y="5" width="3" height="14" rx="1" fill="currentColor" /><path d="M20 6v12a.8.8 0 0 1-1.22.68l-9.6-6a.8.8 0 0 1 0-1.36l9.6-6A.8.8 0 0 1 20 6z" fill="currentColor" /></svg>;
export const NextIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="17" y="5" width="3" height="14" rx="1" fill="currentColor" /><path d="M4 6v12a.8.8 0 0 0 1.22.68l9.6-6a.8.8 0 0 0 0-1.36l-9.6-6A.8.8 0 0 0 4 6z" fill="currentColor" /></svg>;
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
export const BackIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M15 5l-7 7 7 7" {...stroke} /></svg>;
export const ChevronIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M9 5l7 7-7 7" {...stroke} /></svg>;
export const CameraIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" {...stroke} /><circle cx="12" cy="13.2" r="3.4" {...stroke} /></svg>;
export const FileIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" {...stroke} /><path d="M14 3v5h5" {...stroke} /></svg>;
export const RotateIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M20 12a8 8 0 1 1-2.6-5.9" {...stroke} /><path d="M20 4v5h-5" {...stroke} /></svg>;
export const TrashIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6" {...stroke} /></svg>;
export const CloseIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M6 6l12 12M18 6L6 18" {...stroke} /></svg>;
export const CheckIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M5 12.5l4.5 4.5L19 7.5" {...stroke} /></svg>;
export const AlertIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M12 4l9 16H3z" {...stroke} /><path d="M12 10v4.5M12 17.4v.1" {...stroke} /></svg>;
export const MetronomeIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M9 3h6l4 18H5z" {...stroke} /><path d="M12 15l5-9" {...stroke} /></svg>;
export const SoundIcon = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M4 10v4h3l5 4V6l-5 4z" {...stroke} /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" {...stroke} /></svg>;
/** Brand mark: a trumpet bell in a rounded square. */
export const BrandMark = ({ size = 36, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable={false} className={className}>
    <rect width="64" height="64" rx="14" fill="var(--accent)" />
    <path d="M12 28h22c6 0 12-4 16-10v28c-4-6-10-10-16-10H12z" fill="var(--accent-ink)" />
    <rect x="18" y="38" width="4" height="10" rx="2" fill="var(--accent-ink)" /><rect x="25" y="38" width="4" height="10" rx="2" fill="var(--accent-ink)" />
  </svg>
);
