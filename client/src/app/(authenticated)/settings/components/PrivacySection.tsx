/**
 * Settings — Privacy section:
 * self-destruct timer, discoverable toggle + invite tokens, hidden chats toggle, hidden PIN modals.
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import QRCode from "qrcode";
import { Button, Input, Modal } from "@/components/ui";
import type { Settings } from "@/crypto/storage";
import {
  hashHiddenChatPin,
  saveSettings,
  verifyHiddenChatPin,
  deriveMasterKeyFromPin,
} from "@/crypto/storage";
import { useAuthStore, useChatsStore, useUIStore } from "@/stores";
import { inviteApi, profileApi } from "@/lib/api";
import { SectionHeading, ChipSelector, ToggleRow } from "./shared";
import { vaultHasKeys, vaultGetMasterKey, vaultHasMasterKey } from "@/crypto/keyVault";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const SELF_DESTRUCT_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Off", value: null },
  { label: "5 s", value: 5 },
  { label: "30 s", value: 30 },
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "1 hr", value: 3600 },
];

type HiddenPinMode = "setup" | "change" | "reset";

interface PrivacySectionProps {
  settings: Settings;
  onSettingsChange: (next: Settings) => void;
  onUpdate: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onSaveFlash: () => void;
}

export default function PrivacySection({
  settings,
  onSettingsChange,
  onUpdate,
  onSaveFlash,
}: PrivacySectionProps) {
  const setChats = useChatsStore((s) => s.setChats);
  const setShowHiddenChats = useUIStore((s) => s.setShowHiddenChats);

  // Discoverable / invite state — fetch real value on mount
  const [discoverable, setDiscoverable] = useState<boolean | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null);
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState<string | null>(null);
  const [countdown, setCountdown] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch discoverable state from server on mount
  useEffect(() => {
    const { userId } = useAuthStore.getState();
    if (!userId || !vaultHasKeys()) return;
    let cancelled = false;
    void profileApi.get(userId).then((result) => {
      if (cancelled) return;
      if (result.data) {
        setDiscoverable(result.data.discoverable ?? true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const handleToggleDiscoverable = useCallback(async (enabled: boolean) => {
    const { userId } = useAuthStore.getState();
    if (!userId || !vaultHasKeys()) return;
    const result = await inviteApi.setDiscoverable(userId, enabled);
    if (result.data) {
      setDiscoverable(result.data.discoverable);
      useAuthStore.getState().setDiscoverable(result.data.discoverable);
      if (enabled) {
        setInviteToken(null);
        setInviteExpiresAt(null);
        setInviteQrDataUrl(null);
      }
    }
  }, []);

  const handleGenerateInvite = useCallback(async () => {
    const { userId } = useAuthStore.getState();
    if (!userId || !vaultHasKeys()) return;
    setInviteLoading(true);
    try {
      const result = await inviteApi.createToken(userId);
      if (result.data) {
        setInviteToken(result.data.token);
        setInviteExpiresAt(result.data.expiresAt);
        const link = `${APP_URL}/invite/${result.data.token}`;
        const qr = await QRCode.toDataURL(link, {
          width: 200,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        setInviteQrDataUrl(qr);
      }
    } finally {
      setInviteLoading(false);
    }
  }, []);

  const handleCopyInviteLink = useCallback(() => {
    if (!inviteToken) return;
    const link = `${APP_URL}/invite/${inviteToken}`;
    void navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [inviteToken]);

  // Countdown timer for invite token expiry
  useEffect(() => {
    if (!inviteExpiresAt) {
      setCountdown("");
      return;
    }

    const tick = () => {
      const remaining = inviteExpiresAt - Math.floor(Date.now() / 1000);
      if (remaining <= 0) {
        setCountdown("Expired");
        setInviteToken(null);
        setInviteExpiresAt(null);
        setInviteQrDataUrl(null);
        return;
      }

      if (remaining <= 5 && !inviteLoading) {
        void handleGenerateInvite();
        return;
      }

      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const s = remaining % 60;
      setCountdown(
        h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`,
      );
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [inviteExpiresAt, inviteLoading, handleGenerateInvite]);

  // Hidden chats state
  const [showHiddenPinModal, setShowHiddenPinModal] = useState(false);
  const [hiddenPinMode, setHiddenPinMode] = useState<HiddenPinMode>("setup");
  const [hiddenCurrentPin, setHiddenCurrentPin] = useState("");
  const [hiddenAccountPin, setHiddenAccountPin] = useState("");
  const [hiddenPin, setHiddenPin] = useState("");
  const [hiddenPinConfirm, setHiddenPinConfirm] = useState("");
  const [hiddenPinError, setHiddenPinError] = useState<string | null>(null);

  const resetHiddenPinForm = useCallback(() => {
    setHiddenCurrentPin("");
    setHiddenAccountPin("");
    setHiddenPin("");
    setHiddenPinConfirm("");
    setHiddenPinError(null);
  }, []);

  const openHiddenPinModal = useCallback(
    (mode: HiddenPinMode) => {
      setHiddenPinMode(mode);
      resetHiddenPinForm();
      setShowHiddenPinModal(true);
    },
    [resetHiddenPinForm],
  );

  const handleSubmitHiddenPin = async () => {
    setHiddenPinError(null);

    if (hiddenPin.length < 4) {
      setHiddenPinError("PIN must be at least 4 characters");
      return;
    }
    if (hiddenPin !== hiddenPinConfirm) {
      setHiddenPinError("PINs do not match");
      return;
    }

    try {
      if (hiddenPinMode === "change") {
        if (!settings.hiddenChatPinHash) {
          setHiddenPinError("Hidden chats PIN is not configured");
          return;
        }
        if (hiddenCurrentPin.length < 4) {
          setHiddenPinError("Enter current hidden chats PIN");
          return;
        }
        const ok = await verifyHiddenChatPin(
          hiddenCurrentPin,
          settings.hiddenChatPinHash,
        );
        if (!ok) {
          setHiddenPinError("Current hidden chats PIN is incorrect");
          return;
        }
      }

      if (hiddenPinMode === "reset") {
        if (!vaultHasMasterKey()) {
          setHiddenPinError("Unlock session required");
          return;
        }
        // Verify the entered account PIN by deriving a key and comparing with session key
        const currentMasterKey = vaultGetMasterKey();
        const derivedKey = await deriveMasterKeyFromPin(hiddenAccountPin);
        // Constant-time comparison
        if (derivedKey.length !== currentMasterKey.length) {
          setHiddenPinError("Account PIN is incorrect");
          return;
        }
        let diff = 0;
        for (let i = 0; i < derivedKey.length; i++) {
          diff |= derivedKey[i]! ^ currentMasterKey[i]!;
        }
        if (diff !== 0) {
          setHiddenPinError("Account PIN is incorrect");
          return;
        }
      }

      const hiddenChatPinHash = await hashHiddenChatPin(hiddenPin);
      const next: Settings = {
        ...settings,
        hiddenChatsEnabled: true,
        hiddenChatPinHash,
      };
      onSettingsChange(next);
      if (!vaultHasMasterKey()) {
        setHiddenPinError("Unlock session required to save hidden PIN");
        return;
      }
      await saveSettings(next, vaultGetMasterKey());
      setShowHiddenPinModal(false);
      resetHiddenPinForm();
      onSaveFlash();
    } catch {
      setHiddenPinError("Failed to save hidden chats PIN");
    }
  };

  const handleToggleHiddenChats = (enabled: boolean) => {
    if (!enabled) {
      setShowHiddenChats(false);
      const visibleChats = useChatsStore
        .getState()
        .chats.map((chat) => (chat.isHidden ? { ...chat, isHidden: false } : chat));
      setChats(visibleChats);
      void onUpdate("hiddenChatsEnabled", false);
      return;
    }

    if (settings.hiddenChatPinHash) {
      void onUpdate("hiddenChatsEnabled", true);
      return;
    }

    openHiddenPinModal("setup");
  };

  return (
    <>
      <section>
        <SectionHeading>Privacy</SectionHeading>

        <div className="mb-4">
          <p className="text-[13px] text-[var(--text-secondary)] mb-3">
            Self-destruct default
          </p>
          <ChipSelector<number | null>
            options={SELF_DESTRUCT_OPTIONS}
            value={settings.selfDestructDefault}
            onChange={(v) => onUpdate("selfDestructDefault", v)}
          />
        </div>

        <ToggleRow
          label="Discoverable by username"
          description="When off, others can only find you via invite link"
          checked={discoverable ?? true}
          onChange={(v) => void handleToggleDiscoverable(v)}
        />

        {discoverable === false ? (
          <div
            className="rounded-xl p-4 mb-4"
            style={{ background: "var(--surface-secondary)" }}
          >
            <p className="text-[12px] text-[var(--text-muted)] mb-3">
              Share this link so others can add you
            </p>

            {!inviteToken ? (
              <Button
                onClick={() => void handleGenerateInvite()}
                disabled={inviteLoading}
                className="w-full"
              >
                {inviteLoading ? "Generating..." : "Generate invite link"}
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate text-[12px] text-[var(--text-secondary)] font-mono">
                    {`${APP_URL}/invite/${inviteToken}`}
                  </code>
                  <Button
                    onClick={handleCopyInviteLink}
                    className="shrink-0 text-[12px]"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                </div>

                <p className="text-[12px] text-[var(--text-muted)] text-center">
                  Expires in {countdown}
                </p>

                {inviteQrDataUrl ? (
                  <div className="flex justify-center">
                    <img
                      src={inviteQrDataUrl}
                      alt="Invite QR code"
                      width={180}
                      height={180}
                      className="rounded-lg"
                      style={{ background: "#ffffff" }}
                    />
                  </div>
                ) : null}

                <Button
                  onClick={() => void handleGenerateInvite()}
                  disabled={inviteLoading}
                  className="w-full"
                >
                  {inviteLoading ? "Generating..." : "Generate new"}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        <ToggleRow
          label="Hidden Chats"
          description="Enable a separate hidden chat list protected by PIN"
          checked={settings.hiddenChatsEnabled}
          onChange={handleToggleHiddenChats}
        />

        {settings.hiddenChatsEnabled ? (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => openHiddenPinModal("change")}
              className="flex-1 apple-button-secondary text-[12px]"
            >
              Change Hidden PIN
            </button>
            <button
              type="button"
              onClick={() => openHiddenPinModal("reset")}
              className="flex-1 apple-button-secondary text-[12px]"
            >
              Reset Hidden PIN
            </button>
          </div>
        ) : null}
      </section>

      <Modal
        isOpen={showHiddenPinModal}
        onClose={() => {
          setShowHiddenPinModal(false);
          resetHiddenPinForm();
        }}
        title={
          hiddenPinMode === "setup"
            ? "Hidden Chats PIN"
            : hiddenPinMode === "change"
              ? "Change Hidden PIN"
              : "Reset Hidden PIN"
        }
      >
        <div className="space-y-4">
          <p className="text-[12px] text-[var(--text-secondary)]">
            {hiddenPinMode === "setup"
              ? "Create a separate PIN for opening hidden chats."
              : hiddenPinMode === "change"
                ? "Enter current hidden PIN and set a new one."
                : "Reset hidden PIN using your account PIN and set a new hidden PIN."}
          </p>

          {hiddenPinMode === "change" ? (
            <Input
              type="password"
              placeholder="Current hidden PIN"
              aria-label="Current hidden PIN"
              value={hiddenCurrentPin}
              onChange={(e) => setHiddenCurrentPin(e.target.value)}
              autoFocus
            />
          ) : null}

          {hiddenPinMode === "reset" ? (
            <Input
              type="password"
              placeholder="Account PIN"
              aria-label="Account PIN"
              value={hiddenAccountPin}
              onChange={(e) => setHiddenAccountPin(e.target.value)}
              autoFocus
            />
          ) : null}

          <Input
            type="password"
            placeholder="New hidden PIN"
            aria-label="New hidden PIN"
            value={hiddenPin}
            onChange={(e) => setHiddenPin(e.target.value)}
            autoFocus={hiddenPinMode === "setup"}
          />
          <Input
            type="password"
            placeholder="Confirm new hidden PIN"
            aria-label="Confirm new hidden PIN"
            value={hiddenPinConfirm}
            onChange={(e) => setHiddenPinConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSubmitHiddenPin()}
          />

          {hiddenPinError ? (
            <p className="text-[12px] text-red-500 text-center">{hiddenPinError}</p>
          ) : null}

          <Button
            onClick={() => void handleSubmitHiddenPin()}
            disabled={!hiddenPin || !hiddenPinConfirm}
            className="w-full"
          >
            {hiddenPinMode === "setup"
              ? "Enable Hidden Chats"
              : hiddenPinMode === "change"
                ? "Change Hidden PIN"
                : "Reset Hidden PIN"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
