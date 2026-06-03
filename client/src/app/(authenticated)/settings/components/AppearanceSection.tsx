/**
 * Settings — Appearance section (theme selector).
 */

"use client";

import type { Settings } from "@/crypto/storage";
import { SectionHeading, ChipSelector } from "./shared";

interface AppearanceSectionProps {
  settings: Settings;
  onUpdate: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export default function AppearanceSection({
  settings,
  onUpdate,
}: AppearanceSectionProps) {
  return (
    <section>
      <SectionHeading>Appearance</SectionHeading>
      <p className="text-[13px] text-[var(--text-secondary)] mb-3">Theme</p>
      <ChipSelector<"light" | "dark" | "system">
        options={[
          { label: "Light", value: "light" },
          { label: "Dark", value: "dark" },
          { label: "System", value: "system" },
        ]}
        value={settings.theme}
        onChange={(v) => onUpdate("theme", v)}
      />
    </section>
  );
}
