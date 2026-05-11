'use client';

import { useEffect, useRef, useState } from 'react';

interface FieldDef {
  key: string;
  label: string;
  displayKey?: string;
  type: 'number' | 'text' | 'select';
  display?: 'minutes';
  step?: number;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  hint?: string;
}

const FIELDS: FieldDef[] = [
  { key: 'CLIENT_CHANNEL_ID', label: '対象 YouTube チャンネル ID', type: 'text', hint: 'UCxxxxxxxxxxxxxxxxxxxxxx 形式。変更後は次回ポーリングから反映されます。' },
  { key: 'DISPLAY_LIMIT', label: '表示順位数', type: 'select', options: [
      { value: '50', label: '50位' },
      { value: '100', label: '100位 (ページング)' },
    ] },
  { key: 'BACKGROUND_LIMIT', label: 'バックグラウンド収集数', type: 'number', min: 1, step: 1 },
  { key: 'YUTURA_INTERVAL_HOURS', label: 'yutura ポーリング (時間)', type: 'number', min: 1, step: 1 },
  { key: 'YOUTUBE_POLL_INTERVAL_HOURS', displayKey: 'YOUTUBE_POLL_INTERVAL_MINUTES', label: 'YouTube ポーリング (分)', type: 'number', display: 'minutes', min: 1, step: 1, hint: 'YouTube API ポーリング周期。5 分なら 5 と入力します。' },
  { key: 'TIMEZONE', label: 'タイムゾーン', type: 'text' },
];

function toDisplayValue(field: FieldDef, value: string | number | undefined): string {
  if (value == null || value === '') return '';
  if (field.display === 'minutes') {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 60 * 1000) / 1000) : String(value);
  }
  return String(value);
}

function toPayloadValues(values: Record<string, string>): Record<string, string> {
  const payload = { ...values };
  for (const field of FIELDS) {
    if (field.display !== 'minutes') continue;
    const raw = payload[field.key];
    if (raw == null || raw === '') continue;
    const minutes = Number(raw);
    if (Number.isFinite(minutes)) payload[field.key] = String(minutes / 60);
  }
  return payload;
}

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="環境設定"
        aria-expanded={open}
        className="w-[28px] h-[28px] inline-flex items-center justify-center rounded-md transition-colors hover:bg-[rgba(0,178,255,0.12)]"
        style={{ color: open ? 'var(--color-primary)' : 'var(--color-muted)' }}
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx={12} cy={12} r={3} />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && <SettingsPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings')
      .then(async (r) => {
        if (!r.ok) throw new Error(`fetch_failed status=${r.status}`);
        return r.json() as Promise<Record<string, string | number>>;
      })
      .then((data) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const f of FIELDS) {
          const v = data[f.key];
          next[f.key] = toDisplayValue(f, v);
        }
        setValues(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!values) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayloadValues(values)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `save_failed status=${res.status}`);
      }
      // Snapshot/limit values are baked into SSR, so reload to pick them up.
      window.location.reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="環境設定"
      className="absolute right-0 top-[calc(100%+8px)] z-50 w-[360px] max-h-[80vh] overflow-y-auto rounded-md p-4"
      style={{
        background: 'var(--color-surface-strong)',
        border: '1px solid var(--color-border-strong)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[14px] font-[700]" style={{ color: 'var(--color-soft)' }}>
          環境設定
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="w-[24px] h-[24px] inline-flex items-center justify-center rounded text-[16px] leading-none hover:bg-[rgba(255,255,255,0.06)]"
          style={{ color: 'var(--color-muted)' }}
        >
          ×
        </button>
      </div>

      {!values && !loadError && (
        <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>読み込み中…</div>
      )}
      {loadError && (
        <div className="text-[12px]" style={{ color: 'var(--color-decrease)' }}>
          読み込み失敗: {loadError}
        </div>
      )}

      {values && (
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-[12px]">
              <span style={{ color: 'var(--color-soft)' }}>
                {f.label}
                <span className="ml-1 opacity-50 font-mono text-[10px]">{f.displayKey ?? f.key}</span>
              </span>
              {f.type === 'select' ? (
                <select
                  value={values[f.key]}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="px-2 py-1 rounded outline-none"
                  style={{
                    background: 'rgba(0,0,0,0.4)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                >
                  {f.options!.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type}
                  value={values[f.key]}
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="px-2 py-1 rounded outline-none"
                  style={{
                    background: 'rgba(0,0,0,0.4)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                />
              )}
              {f.hint && (
                <span className="text-[10px]" style={{ color: 'var(--color-muted)' }}>{f.hint}</span>
              )}
            </label>
          ))}

          {saveError && (
            <div className="text-[11px]" style={{ color: 'var(--color-decrease)' }}>
              保存失敗: {saveError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1 rounded text-[12px] disabled:opacity-50"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border)',
                color: 'var(--color-muted)',
              }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1 rounded text-[12px] font-[600] disabled:opacity-50"
              style={{ background: 'var(--color-primary)', color: '#001019' }}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
