/**
 * Settings page — thin orchestrator that composes section components.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, SettingsSkeleton } from "@/components/ui";
import MessengerShell from "@/components/messenger/MessengerShell";
import LeftRail from "@/components/messenger/LeftRail";
import { useHydrated } from "@/hooks/useMessengerSync";
import { usePanic } from "@/hooks/usePanic";
import { useAuthStore } from "@/stores";
import { loadSettings, saveSettings, type Settings } from "@/crypto/storage";
import { applyTheme } from "@/lib/theme";
import { isSoundEnabled } from "@/lib/sounds";
import { vaultGetMasterKey, vaultHasMasterKey } from "@/crypto/keyVault";

import ProfileSection from "./components/ProfileSection";
import AppearanceSection from "./components/AppearanceSection";
import NotificationsSection from "./components/NotificationsSection";
import PrivacySection from "./components/PrivacySection";
import SecuritySection from "./components/SecuritySection";
import DangerZoneSection from "./components/DangerZoneSection";

export default function SettingsPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { isPanicMode, showPanicConfirm, setShowPanicConfirm, executePanic } =
    usePanic();

  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [backupWarning, setBackupWarning] = useState(false);

  useEffect(() => {
    if (hydrated && !isAuthenticated) {
      router.push("/");
    }
  }, [hydrated, isAuthenticated, router]);

  useEffect(() => {
    if (hydrated && isAuthenticated) {
      const mk = vaultHasMasterKey() ? vaultGetMasterKey() : undefined;
      loadSettings(mk).then(setSettingsState);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSoundOn(isSoundEnabled());
    }
  }, [hydrated, isAuthenticated]);

  const triggerSaveFlash = useCallback(() => {
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1200);
  }, []);

  const updateSetting = useCallback(
    async <K extends keyof Settings>(key: K, value: Settings[K]) => {
      if (!settings) return;
      const next = { ...settings, [key]: value };
      setSettingsState(next);
      if (key === "theme") {
        applyTheme(value as Settings["theme"], true);
      }
      const mk = vaultHasMasterKey() ? vaultGetMasterKey() : undefined;
      await saveSettings(next, mk);
      triggerSaveFlash();
    },
    [settings, triggerSaveFlash],
  );

  if (!hydrated || !settings) {
    return (
      <div className="h-[100dvh] w-full overflow-hidden">
        <div className="md:hidden h-full min-h-0 p-2 sm:p-4">
          <SettingsSkeleton />
        </div>
        <div className="hidden md:block h-full min-h-0">
          <MessengerShell
            leftRail={<div className="h-full" />}
            chatList={<SettingsSkeleton />}
            main={
              <div
                aria-busy="true"
                className="lume-panel h-full rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] flex items-center justify-center"
              >
                <div className="w-8 h-8 border-2 mono-spinner rounded-full animate-spin" />
              </div>
            }
          />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  if (isPanicMode) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[var(--text-secondary)] uppercase tracking-[0.18em] text-sm">
          No messages
        </p>
      </div>
    );
  }

  const settingsContent = (
    <div className="lume-panel h-full rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] overflow-hidden flex flex-col">
      <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-4 sm:pb-5 border-b border-[var(--border)]/70 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => router.push("/chats")}
            className="lume-icon-btn md:hidden flex-shrink-0"
            aria-label="Back to chats"
            title="Back"
          >
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <h1 className="text-[12px] font-semibold uppercase tracking-[0.34em] text-[var(--text-primary)]">
            Settings
          </h1>
        </div>
        {saveFlash ? (
          <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)] animate-pulse flex-shrink-0">
            Saved
          </span>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5 sm:py-6 space-y-8 animate-fade-in-up">
        <ProfileSection />

        <AppearanceSection settings={settings} onUpdate={updateSetting} />

        <NotificationsSection
          settings={settings}
          soundOn={soundOn}
          onSoundChange={setSoundOn}
          onUpdate={updateSetting}
        />

        <PrivacySection
          settings={settings}
          onSettingsChange={setSettingsState}
          onUpdate={updateSetting}
          onSaveFlash={triggerSaveFlash}
        />

        {backupWarning ? (
          <div className="p-3 rounded-[var(--radius-md)] border border-[var(--text-muted)]/30 bg-[var(--surface-alt)]">
            <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
              <span className="font-semibold">PIN changed.</span> Old backups
              are encrypted with the previous PIN. Create a new backup to use
              the current PIN.
            </p>
            <button
              type="button"
              onClick={() => setBackupWarning(false)}
              className="mt-2 text-[11px] uppercase tracking-[0.1em] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <SecuritySection onBackupWarning={setBackupWarning} />

        <DangerZoneSection />
      </div>

      <Modal
        isOpen={showPanicConfirm}
        onClose={() => setShowPanicConfirm(false)}
        title="WIPE ALL DATA"
      >
        <div className="space-y-4">
          <p className="text-[13px] text-[var(--text-secondary)] text-center">
            All local data will be permanently erased. This cannot be undone.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowPanicConfirm(false)}
              className="apple-button-secondary flex-1"
            >
              Cancel
            </button>
            <Button onClick={executePanic} className="flex-1">
              Confirm Wipe
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );

  const desktopPlaceholder = (
    <div className="lume-panel h-full rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto rounded-full border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center mb-4">
          <svg
            className="w-7 h-7 text-[var(--text-muted)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <circle cx="12" cy="12" r="3" strokeWidth="1.8" />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
            />
          </svg>
        </div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
          Manage your preferences
        </p>
      </div>
    </div>
  );

  return (
    <div className="h-[100dvh] w-full overflow-hidden">
      {/* Mobile: settings panel full-screen */}
      <div className="md:hidden h-full min-h-0 p-2 sm:p-4">
        {settingsContent}
      </div>

      {/* Desktop: sidebar shell */}
      <div className="hidden md:block h-full min-h-0">
        <MessengerShell
          leftRail={<LeftRail onPanic={() => setShowPanicConfirm(true)} />}
          chatList={settingsContent}
          main={desktopPlaceholder}
          rightRail={undefined}
        />
      </div>
    </div>
  );
}
