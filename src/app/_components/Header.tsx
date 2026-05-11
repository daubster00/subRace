import { SettingsButton } from './SettingsPanel';

export function Header() {
  return (
    <header
      className="flex-none h-[42px] flex items-center justify-between px-[var(--page-padding)]"
      style={{ borderBottom: '1px solid rgba(0,178,255,0.16)' }}
    >
      <div className="inline-flex items-center gap-[9px]">
        <span
          className="w-[26px] h-[26px] inline-flex items-center justify-center"
          style={{ color: 'var(--color-primary)', filter: 'drop-shadow(0 0 10px rgba(0,178,255,0.75))' }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 48 48" width={26} height={26} fill="none" stroke="currentColor" strokeWidth={3} strokeLinejoin="round">
            <path d="M14 8L39 24L14 40V8Z" />
            <path d="M21 15L34 24L21 33" />
          </svg>
        </span>
        <span className="text-[20px] font-[800]" style={{ letterSpacing: 0 }}>
          ライブサブランク
        </span>
      </div>
      <SettingsButton />
    </header>
  );
}
