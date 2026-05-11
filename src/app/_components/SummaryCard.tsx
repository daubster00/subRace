interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

export function SummaryCard({ icon, label, value }: SummaryCardProps) {
  return (
    <article
      className="min-h-[42px] flex items-center justify-center gap-[7px] px-[9px] py-[6px]"
      style={{
        background: 'linear-gradient(180deg, rgba(12,28,45,0.9), rgba(8,18,30,0.84))',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-card)',
        boxShadow: '0 0 24px rgba(0,178,255,0.06), inset 0 0 0 1px var(--color-border)',
      }}
    >
      <span className="inline-flex items-center gap-[5px] text-[12px] font-[700] whitespace-nowrap" style={{ color: '#d6e2f2', letterSpacing: 0 }}>
        <span className="w-[16px] h-[16px] flex-none" style={{ color: 'var(--color-primary)' }} aria-hidden="true">
          {icon}
        </span>
        {label}
      </span>
      <strong className="text-[16px] font-[850] leading-none" style={{ letterSpacing: 0 }}>
        {value}
      </strong>
    </article>
  );
}
