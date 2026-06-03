/**
 * Shared UI primitives reused across Settings section components.
 */

"use client";

import { useRef, useEffect, useState, useCallback } from "react";

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-4">
      {children}
    </h2>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-3 cursor-pointer select-none">
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-medium text-[var(--text-primary)]">
          {label}
        </p>
        {description ? (
          <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`
          relative w-11 h-6 rounded-full border transition-colors shrink-0
          ${
            checked
              ? "bg-[var(--accent)] border-[var(--accent)]"
              : "bg-[var(--surface-alt)] border-[var(--border)]"
          }
        `}
      >
        <span
          className={`
            absolute top-0.5 left-0.5 w-5 h-5 rounded-full
            [transition:transform_0.3s_cubic-bezier(0.34,1.56,0.64,1)]
            ${
              checked
                ? "translate-x-5 bg-[var(--accent-contrast)]"
                : "translate-x-0 bg-[var(--text-muted)]"
            }
          `}
        />
      </button>
    </label>
  );
}

export function ChipSelector<T extends string | number | null>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const [ready, setReady] = useState(false);

  const updateIndicator = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeIndex = options.findIndex((opt) => opt.value === value);
    if (activeIndex < 0) {
      setReady(false);
      return;
    }
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      "[data-chip-option]",
    );
    const activeBtn = buttons[activeIndex];
    if (!activeBtn) return;
    setIndicator({
      left: activeBtn.offsetLeft,
      top: activeBtn.offsetTop,
      width: activeBtn.offsetWidth,
      height: activeBtn.offsetHeight,
    });
    setReady(true);
  }, [options, value]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync pill position with DOM layout
    updateIndicator();
  }, [updateIndicator]);

  return (
    <div ref={containerRef} className="relative flex flex-wrap gap-2">
      {ready && (
        <div
          className="absolute rounded-full z-0 bg-[var(--accent)]"
          style={{
            left: indicator.left,
            top: indicator.top,
            width: indicator.width,
            height: indicator.height,
            transition:
              "left 0.2s cubic-bezier(0.4, 0, 0.2, 1), top 0.2s cubic-bezier(0.4, 0, 0.2, 1), width 0.2s cubic-bezier(0.4, 0, 0.2, 1), height 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      )}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            data-chip-option
            onClick={() => onChange(opt.value)}
            className={`
              relative z-[1] px-4 py-2 rounded-full text-[13px] font-medium border transition-colors
              ${
                active
                  ? "text-[var(--accent-contrast)] border-transparent"
                  : "bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border)] hover:bg-[var(--surface-alt)]"
              }
            `}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
