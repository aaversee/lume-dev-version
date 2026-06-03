/**
 * Settings -- Profile section (avatar upload + display name editing).
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Avatar } from "@/components/ui";
import { useAuthStore } from "@/stores";
import { profileApi, filesApi } from "@/lib/api";
import { downloadAndCacheAvatar, getCachedAvatarUrl } from "@/lib/avatarCache";
import { SectionHeading } from "./shared";
import { vaultHasKeys } from "@/crypto/keyVault";

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export default function ProfileSection() {
  const userId = useAuthStore((s) => s.userId);
  const username = useAuthStore((s) => s.username);
  const discoverable = useAuthStore((s) => s.discoverable);
  const hasKeys = useAuthStore((s) => s.hasIdentityKeys);

  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarFileId, setAvatarFileId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  // Load profile on mount
  useEffect(() => {
    if (!userId || !vaultHasKeys()) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await profileApi.get(userId);
        if (cancelled || !res.data) return;
        setDisplayName(res.data.displayName ?? "");
        setAvatarFileId(res.data.avatarFileId ?? null);

        if (res.data.avatarFileId) {
          const fid = res.data.avatarFileId;
          const cached = getCachedAvatarUrl(fid);
          if (cached) {
            setAvatarUrl(cached);
          } else {
            const url = await downloadAndCacheAvatar(fid, async () => {
              const r = await filesApi.download(fid);
              if (!r.data) return null;
              return { data: r.data.data, mimeHint: r.data.mimeHint };
            });
            if (!cancelled) setAvatarUrl(url);
          }
        }
      } catch {
        // Best-effort load
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => { cancelled = true; };
  }, [userId, hasKeys]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userId || !vaultHasKeys()) return;
    // Reset the input so same file can be selected again
    e.target.value = "";

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError("Only PNG, JPEG, and WebP images are supported.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError("Image must be under 2 MB.");
      return;
    }

    setError(null);
    setUploading(true);

    try {
      // Read as base64
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const base64 = btoa(binary);

      // Upload file
      const uploadRes = await filesApi.upload(base64, file.type);
      if (uploadRes.error || !uploadRes.data) {
        setError(uploadRes.error ?? "Upload failed.");
        return;
      }

      const newFileId = uploadRes.data.fileId;

      // Update profile with new avatarFileId
      const updateRes = await profileApi.update(userId, { avatarFileId: newFileId });
      if (updateRes.error) {
        setError(updateRes.error);
        return;
      }

      setAvatarFileId(newFileId);

      // Create local object URL for immediate display
      const blob = new Blob([bytes], { type: file.type });
      const url = URL.createObjectURL(blob);
      setAvatarUrl(url);
    } catch {
      setError("Failed to upload avatar.");
    } finally {
      setUploading(false);
    }
  }, [userId, hasKeys]);

  const saveDisplayName = useCallback(async () => {
    if (!userId || !vaultHasKeys()) return;
    const name = displayNameRef.current.trim();
    setSaving(true);
    setError(null);
    try {
      const res = await profileApi.update(userId, { displayName: name || null });
      if (res.error) {
        setError(res.error);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setError("Failed to save display name.");
    } finally {
      setSaving(false);
    }
  }, [userId]);

  if (!loaded) {
    return (
      <section>
        <SectionHeading>Profile</SectionHeading>
        <div className="flex items-center gap-5">
          <div className="w-24 h-24 rounded-full bg-[var(--surface-strong)] border border-[var(--border)] animate-pulse" />
          <div className="flex-1 space-y-3">
            <div className="h-4 w-32 rounded bg-[var(--surface-strong)] animate-pulse" />
            <div className="h-10 w-full rounded-[var(--radius-md)] bg-[var(--surface-strong)] animate-pulse" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Profile</SectionHeading>
      <div className="flex items-start gap-5">
        {/* Avatar with edit overlay */}
        <div className="relative group flex-shrink-0">
          <Avatar src={avatarUrl} username={username ?? "U"} size="xl" />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-0 rounded-full bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center cursor-pointer disabled:cursor-wait"
            aria-label="Change avatar"
          >
            <svg
              className="w-7 h-7 text-white opacity-0 group-hover:opacity-100 transition-opacity"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
              />
              <circle cx="12" cy="13" r="4" strokeWidth="1.8" />
            </svg>
          </button>
          {uploading ? (
            <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void handleFileSelect(e)}
          />
        </div>

        {/* Name fields */}
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)] mb-1 block">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => void saveDisplayName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void saveDisplayName();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Enter display name"
              maxLength={64}
              className="apple-input w-full"
            />
            {saving ? (
              <p className="text-[11px] text-[var(--text-muted)] mt-1 animate-pulse">
                Saving...
              </p>
            ) : saved ? (
              <p className="text-[11px] text-[var(--accent)] mt-1">
                Saved
              </p>
            ) : null}
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)] mb-1 block">
              Username
            </label>
            <p className="text-[14px] text-[var(--text-muted)] font-medium">
              {!discoverable ? "Hidden" : `@${username ?? "unknown"}`}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-[12px] text-red-400">{error}</p>
      ) : null}
    </section>
  );
}
