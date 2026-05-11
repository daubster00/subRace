export function Legend() {
  return (
    <section
      aria-label="凡例"
      className="flex-none flex items-center gap-[7px] mt-[5px] mb-[5px]"
    >
      <span className="inline-flex items-center gap-[7px] h-[24px] px-[10px] text-[11px] font-[650] rounded-[8px]"
        style={{ color: '#eef6ff', background: 'rgba(9,21,34,0.78)', border: '1px solid var(--color-border)', letterSpacing: 0 }}
      >
        <span className="inline-block w-[8px] h-[8px] rounded-full" style={{ background: 'var(--color-increase)' }} />
        登録者増加
      </span>
      <span className="inline-flex items-center gap-[7px] h-[24px] px-[10px] text-[11px] font-[650] rounded-[8px]"
        style={{ color: '#eef6ff', background: 'rgba(9,21,34,0.78)', border: '1px solid var(--color-border)', letterSpacing: 0 }}
      >
        <span className="inline-block w-[8px] h-[8px] rounded-full" style={{ background: 'var(--color-decrease)' }} />
        登録者減少
      </span>
      <span className="inline-flex items-center gap-[7px] h-[24px] px-[10px] text-[11px] font-[650] rounded-[8px]"
        style={{ color: '#eef6ff', background: 'rgba(9,21,34,0.78)', border: '1px solid var(--color-border)', letterSpacing: 0 }}
      >
        <span className="inline-block w-[8px] h-[8px] rounded-full" style={{ background: '#9b6eeb', boxShadow: '0 0 8px rgba(155,110,235,0.6)' }} />
        順位変動間近
      </span>
    </section>
  );
}
