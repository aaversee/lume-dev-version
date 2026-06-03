"use client";

import type { ReactNode } from "react";
import { useMessengerSync } from "@/hooks/useMessengerSync";

/**
 * Shared layout for all authenticated routes (chats, chat/[id], settings).
 *
 * Running useMessengerSync here means the WebSocket connection, local-data
 * hydration, message/read handlers, and persistence subscriptions live ONCE per
 * session. Navigating between authenticated pages keeps this layout mounted, so
 * we no longer repeat getSession / IndexedDB reloads / handler churn on every
 * route change (the previous behaviour when the hook was mounted per page).
 */
export default function AuthenticatedLayout({
  children,
}: {
  children: ReactNode;
}) {
  useMessengerSync();
  return <>{children}</>;
}
