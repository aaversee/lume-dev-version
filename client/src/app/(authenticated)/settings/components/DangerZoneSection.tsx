/**
 * Settings — Danger Zone section (delete account).
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui";
import { panicWipe, deriveMasterKeyFromPin, loadIdentityKeys } from "@/crypto/storage";
import { authApi } from "@/lib/api";
import { useAuthStore } from "@/stores";
import { SectionHeading } from "./shared";

export default function DangerZoneSection() {
  const router = useRouter();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletePin, setDeletePin] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  const handleDeleteAccount = async () => {
    if (deletePin.length < 4) {
      setDeleteError("Enter your PIN to confirm");
      return;
    }
    setDeleteError("");
    setDeleteLoading(true);
    try {
      const mk = await deriveMasterKeyFromPin(deletePin);
      const identity = await loadIdentityKeys(mk, deletePin);
      if (!identity) {
        setDeleteError("Invalid PIN");
        return;
      }

      const uid = useAuthStore.getState().userId;
      if (identity && uid) {
        try {
          await authApi.deleteAccount(uid);
        } catch {
          // Best effort.
        }
      }

      await panicWipe();
      useAuthStore.getState().clearAuth();
      router.push("/");
    } catch {
      setDeleteError("Verification failed");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <>
      <section>
        <SectionHeading>Danger Zone</SectionHeading>
        <button
          type="button"
          onClick={() => setShowDeleteAccount(true)}
          className="w-full py-3 px-4 rounded-[var(--radius-md)] border border-red-500/30 text-red-500 text-[13px] font-semibold uppercase tracking-[0.1em] hover:bg-red-500/5 transition-colors"
        >
          Delete Account & Wipe Data
        </button>
      </section>

      <Modal
        isOpen={showDeleteAccount}
        onClose={() => { setShowDeleteAccount(false); setDeletePin(""); setDeleteError(""); }}
        title="Delete Account"
      >
        <div className="space-y-4">
          <p className="text-[13px] text-[var(--text-secondary)] text-center">
            This will permanently erase all local data including keys,
            contacts, and messages. This action cannot be undone.
          </p>
          <input
            type="password"
            value={deletePin}
            onChange={(e) => setDeletePin(e.target.value)}
            placeholder="Enter PIN to confirm"
            className="apple-input text-center tracking-[0.2em]"
          />
          {deleteError && (
            <p className="text-xs text-red-500 text-center">{deleteError}</p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setShowDeleteAccount(false); setDeletePin(""); setDeleteError(""); }}
              className="apple-button-secondary flex-1"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteLoading}
              onClick={() => void handleDeleteAccount()}
              className="flex-1 py-3 px-4 rounded-[var(--radius-md)] bg-red-500 text-white text-[13px] font-semibold uppercase tracking-[0.1em] hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {deleteLoading ? "Verifying..." : "Delete Everything"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
