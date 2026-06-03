/**
 * Settings — Security section (change PIN modal).
 */

"use client";

import { useState } from "react";
import { Button, Input, Modal } from "@/components/ui";
import { changePin } from "@/crypto/storage";
import { vaultSetMasterKey } from "@/crypto/keyVault";
import { SectionHeading } from "./shared";

interface SecuritySectionProps {
  onBackupWarning: (show: boolean) => void;
}

export default function SecuritySection({
  onBackupWarning,
}: SecuritySectionProps) {
  const [showPinModal, setShowPinModal] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinLoading, setPinLoading] = useState(false);
  const [pinSuccess, setPinSuccess] = useState(false);

  const openModal = () => {
    setShowPinModal(true);
    setPinError(null);
    setPinSuccess(false);
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
  };

  const handleChangePin = async () => {
    setPinError(null);

    if (newPin.length < 4) {
      setPinError("New PIN must be at least 4 characters");
      return;
    }
    if (newPin !== confirmPin) {
      setPinError("PINs do not match");
      return;
    }
    if (newPin === currentPin) {
      setPinError("New PIN must be different from the current one");
      return;
    }

    setPinLoading(true);
    try {
      const newMasterKey = await changePin(currentPin, newPin);
      vaultSetMasterKey(newMasterKey);
      setPinSuccess(true);
      onBackupWarning(true);
      setTimeout(() => {
        setShowPinModal(false);
        setPinSuccess(false);
        setCurrentPin("");
        setNewPin("");
        setConfirmPin("");
      }, 1500);
    } catch {
      setPinError("Current PIN is incorrect");
    } finally {
      setPinLoading(false);
    }
  };

  return (
    <>
      <section>
        <SectionHeading>Security</SectionHeading>
        <button
          type="button"
          onClick={openModal}
          className="apple-button-secondary w-full text-center"
        >
          Change PIN
        </button>
      </section>

      <Modal
        isOpen={showPinModal}
        onClose={() => setShowPinModal(false)}
        title="Change PIN"
      >
        <div className="space-y-4">
          {pinSuccess ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 mx-auto rounded-full bg-[var(--accent)] flex items-center justify-center mb-3">
                <svg
                  className="w-6 h-6 text-[var(--accent-contrast)]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <p className="text-[14px] font-medium text-[var(--text-primary)]">
                PIN changed successfully
              </p>
            </div>
          ) : (
            <>
              <Input
                type="password"
                placeholder="Current PIN"
                aria-label="Current PIN"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
                autoFocus
              />
              <Input
                type="password"
                placeholder="New PIN"
                aria-label="New PIN"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
              />
              <Input
                type="password"
                placeholder="Confirm New PIN"
                aria-label="Confirm new PIN"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleChangePin()}
              />
              {pinError ? (
                <p className="text-[12px] text-red-500 text-center">{pinError}</p>
              ) : null}
              <Button
                onClick={() => void handleChangePin()}
                disabled={pinLoading || !currentPin || !newPin || !confirmPin}
                className="w-full"
              >
                {pinLoading ? "Changing…" : "Change PIN"}
              </Button>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
