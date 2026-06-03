/**
 * Settings — Notifications section (desktop notifications + sound).
 */

"use client";

import { useState, useCallback } from "react";
import type { Settings } from "@/crypto/storage";
import {
  requestNotificationPermission,
  getNotificationPermission,
} from "@/lib/notifications";
import { subscribeToPush, unsubscribeFromPush } from "@/lib/pushSubscription";
import { setSoundEnabled } from "@/lib/sounds";
import { useAuthStore } from "@/stores";
import { SectionHeading, ToggleRow } from "./shared";

interface NotificationsSectionProps {
  settings: Settings;
  soundOn: boolean;
  onSoundChange: (v: boolean) => void;
  onUpdate: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export default function NotificationsSection({
  settings,
  soundOn,
  onSoundChange,
  onUpdate,
}: NotificationsSectionProps) {
  const [browserPermission, setBrowserPermission] = useState(
    getNotificationPermission,
  );
  const userId = useAuthStore((s) => s.userId);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      void onUpdate("notifications", enabled);
      if (enabled) {
        const granted = await requestNotificationPermission().catch(
          () => false,
        );
        setBrowserPermission(granted ? "granted" : getNotificationPermission());
        if (granted && userId) {
          void subscribeToPush(userId);
        }
      } else if (userId) {
        void unsubscribeFromPush(userId);
      }
    },
    [onUpdate, userId],
  );

  const permissionHint =
    settings.notifications && browserPermission === "denied"
      ? "Blocked by browser — enable in site settings"
      : undefined;

  return (
    <section>
      <SectionHeading>Notifications</SectionHeading>
      <ToggleRow
        label="Desktop Notifications"
        description={permissionHint ?? "Show a notification when a new message arrives"}
        checked={settings.notifications}
        onChange={(v) => void handleToggle(v)}
      />
      <ToggleRow
        label="Sound"
        description="Play a chime when a new message arrives"
        checked={soundOn}
        onChange={(v) => {
          onSoundChange(v);
          setSoundEnabled(v);
        }}
      />
    </section>
  );
}
