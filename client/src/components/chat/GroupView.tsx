"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { groupsApi, filesApi } from "@/lib/api";
import type { GroupData } from "@/lib/api";
import {
  useAuthStore,
  useGroupsStore,
  type Message,
  type MessageAttachment,
} from "@/stores";
import { Button } from "@/components/ui";
import { Avatar } from "@/components/ui/Avatar";
import { MessageBubbleMemo } from "./MessageBubble";
import { TIMER_OPTIONS, formatTimerLabel } from "./chatUtils";
import { vaultHasKeys } from "@/crypto/keyVault";
import { sendGroupMessage } from "@/lib/groupMessaging";
import {
  encryptFile,
  readFileAsUint8Array,
  isImageMime,
  formatFileSize,
  MAX_FILE_SIZE,
} from "@/lib/fileEncryption";
import AddMemberModal from "@/components/modals/AddMemberModal";

interface PendingAttachment {
  file: File;
  preview?: string;
}

interface GroupViewProps {
  group: GroupData;
}

export default function GroupView({ group }: GroupViewProps) {
  const userId = useAuthStore((s) => s.userId);
  const updateGroup = useGroupsStore((s) => s.updateGroup);
  const removeGroup = useGroupsStore((s) => s.removeGroup);
  const setActiveGroup = useGroupsStore((s) => s.setActiveGroup);
  const messages = useGroupsStore((s) => s.messagesByGroup[group.id]);
  const addGroupMessage = useGroupsStore((s) => s.addGroupMessage);
  const updateGroupMessage = useGroupsStore((s) => s.updateGroupMessage);
  const deleteGroupMessage = useGroupsStore((s) => s.deleteGroupMessage);
  const markGroupRead = useGroupsStore((s) => s.markGroupRead);

  const [mode, setMode] = useState<"chat" | "info">("chat");
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pendingAttachment, setPendingAttachment] =
    useState<PendingAttachment | null>(null);
  const [selfDestructTime, setSelfDestructTime] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);

  const [showAddMember, setShowAddMember] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [leavingGroup, setLeavingGroup] = useState(false);
  const [error, setError] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentMember = group.members.find((m) => m.user_id === userId);
  const isAdmin = currentMember?.role === "admin";
  const hasMembersToSend = group.members.some((m) => m.user_id !== userId);

  const groupMessages = useMemo(() => messages ?? [], [messages]);

  const usernameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of group.members) map[m.user_id] = m.username;
    return map;
  }, [group.members]);

  // Reading the group clears its unread badge (and keeps it cleared as messages arrive).
  useEffect(() => {
    markGroupRead(group.id);
  }, [group.id, groupMessages.length, markGroupRead]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [groupMessages.length]);

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      deleteGroupMessage(group.id, messageId);
    },
    [deleteGroupMessage, group.id],
  );

  const handleReply = useCallback((message: Message) => {
    setReplyingTo(message);
  }, []);

  const handleAttach = useCallback((file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      alert(`File too large. Max size: ${formatFileSize(MAX_FILE_SIZE)}`);
      return;
    }
    const preview = file.type.startsWith("image/")
      ? URL.createObjectURL(file)
      : undefined;
    setPendingAttachment((prev) => {
      if (prev?.preview) URL.revokeObjectURL(prev.preview);
      return { file, preview };
    });
  }, []);

  const handleCancelAttachment = useCallback(() => {
    setPendingAttachment((prev) => {
      if (prev?.preview) URL.revokeObjectURL(prev.preview);
      return null;
    });
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleAttach(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSend = async () => {
    const text = messageText.trim();
    const hasAttachment = !!pendingAttachment;
    if (
      (!text && !hasAttachment) ||
      !userId ||
      !hasMembersToSend ||
      !vaultHasKeys()
    )
      return;

    setSending(true);
    const messageId = uuidv4();
    const timestamp = Date.now();
    const replyRef = replyingTo
      ? {
          messageId: replyingTo.id,
          content: replyingTo.content.slice(0, 200),
          senderId: replyingTo.senderId,
        }
      : undefined;

    // Encrypt and upload the attachment once; the symmetric key travels to each
    // member inside their own ratchet-encrypted payload, so the server only ever
    // stores a single opaque blob.
    let attachmentMeta: MessageAttachment | undefined;
    if (pendingAttachment) {
      try {
        const fileData = await readFileAsUint8Array(pendingAttachment.file);
        const encrypted = await encryptFile(
          fileData,
          pendingAttachment.file.type,
          pendingAttachment.file.name,
        );
        const { data: uploadResult, error: uploadError } =
          await filesApi.upload(encrypted.ciphertext, encrypted.mimeType);
        if (uploadError || !uploadResult) {
          throw new Error(uploadError || "File upload failed");
        }
        attachmentMeta = {
          fileId: uploadResult.fileId,
          fileName: encrypted.fileName,
          mimeType: encrypted.mimeType,
          size: encrypted.originalSize,
          key: encrypted.key,
          nonce: encrypted.nonce,
        };
      } catch {
        setSending(false);
        return;
      }
    }

    const msgType = attachmentMeta
      ? isImageMime(attachmentMeta.mimeType)
        ? "image"
        : "file"
      : "text";

    // Optimistic local echo
    addGroupMessage(group.id, {
      id: messageId,
      chatId: group.id,
      senderId: userId,
      content: text,
      type: msgType,
      timestamp,
      status: "sending",
      selfDestructAt: selfDestructTime
        ? timestamp + selfDestructTime * 1000
        : undefined,
      replyTo: replyRef,
      attachment: attachmentMeta,
    });
    setMessageText("");
    setReplyingTo(null);
    if (pendingAttachment?.preview) URL.revokeObjectURL(pendingAttachment.preview);
    setPendingAttachment(null);

    try {
      const result = await sendGroupMessage({
        group,
        senderId: userId,
        content: text,
        timestamp,
        replyTo: replyRef,
        attachment: attachmentMeta,
        selfDestructSeconds: selfDestructTime,
      });
      updateGroupMessage(group.id, messageId, {
        status: result.sent > 0 ? "sent" : "failed",
      });
    } catch {
      updateGroupMessage(group.id, messageId, { status: "failed" });
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleRemoveMember = async (memberUserId: string) => {
    if (!vaultHasKeys()) return;

    setRemovingId(memberUserId);
    setError("");

    const result = await groupsApi.removeMember(group.id, memberUserId);

    if (result.error) {
      setError(result.error);
      setRemovingId(null);
      return;
    }

    updateGroup(group.id, {
      members: group.members.filter((m) => m.user_id !== memberUserId),
    });
    setRemovingId(null);
  };

  const handleLeaveGroup = async () => {
    if (!vaultHasKeys() || !userId) return;

    setLeavingGroup(true);
    setError("");

    const result = await groupsApi.removeMember(group.id, userId);

    if (result.error) {
      setError(result.error);
      setLeavingGroup(false);
      return;
    }

    setActiveGroup(null);
    removeGroup(group.id);
  };

  return (
    <div className="lume-panel h-full min-h-0 rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border)]/70 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setActiveGroup(null)}
            className="lume-icon-btn md:hidden flex-shrink-0"
            aria-label="Back to groups"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="w-10 h-10 rounded-full border border-[var(--border)] bg-[var(--surface-strong)] flex items-center justify-center text-[var(--text-muted)] flex-shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
              <circle cx="9" cy="7" r="4" strokeWidth="1.8" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M23 21v-2a4 4 0 00-3-3.87" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
              {group.name}
            </h2>
            <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-[0.1em]">
              {group.members.length} {group.members.length === 1 ? "member" : "members"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMode((m) => (m === "chat" ? "info" : "chat"))}
          className="lume-icon-btn flex-shrink-0"
          aria-label={mode === "chat" ? "Group info" : "Back to chat"}
          title={mode === "chat" ? "Group info" : "Back to chat"}
        >
          {mode === "chat" ? (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <circle cx="12" cy="12" r="9" strokeWidth="1.8" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 16v-4M12 8h.01" />
            </svg>
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M21 15a4 4 0 01-4 4H8l-5 3V7a4 4 0 014-4h10a4 4 0 014 4v8z" />
            </svg>
          )}
        </button>
      </div>

      {mode === "chat" ? (
        <>
          {/* Messages */}
          <main className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 md:px-6 py-4 sm:py-5 space-y-2">
            {groupMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                  No messages yet
                </p>
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                  Send the first message to the group.
                </p>
              </div>
            ) : (
              <>
                {groupMessages.map((m) => {
                  const isMine = m.senderId === userId;
                  const senderName = usernameById[m.senderId] || "Unknown";
                  let replyAuthorName: string | undefined;
                  if (m.replyTo) {
                    replyAuthorName =
                      m.replyTo.senderId === userId
                        ? "You"
                        : usernameById[m.replyTo.senderId] || "Unknown";
                  }
                  return (
                    <div key={m.id}>
                      {!isMine && (
                        <p className="px-1 mb-0.5 text-[11px] text-[var(--text-muted)]">
                          @{senderName}
                        </p>
                      )}
                      <MessageBubbleMemo
                        message={m}
                        isMine={isMine}
                        onDelete={handleDeleteMessage}
                        onReply={handleReply}
                        replyAuthorName={replyAuthorName}
                      />
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </>
            )}
          </main>

          {/* Input */}
          <footer className="px-3 sm:px-5 md:px-6 py-3 sm:py-4 border-t border-[var(--border)]/70">
            {pendingAttachment && (
              <div className="mb-3 flex items-center gap-3 px-4 py-2.5 rounded-[var(--radius-md)] bg-[var(--surface-alt)] border border-[var(--border)]">
                {pendingAttachment.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={pendingAttachment.preview}
                    alt="Attachment preview"
                    className="w-12 h-12 rounded object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded bg-[var(--surface-strong)] flex items-center justify-center">
                    <svg className="w-6 h-6 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M14 2v6h6" />
                    </svg>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-[var(--text-primary)] truncate">
                    {pendingAttachment.file.name}
                  </p>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {formatFileSize(pendingAttachment.file.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCancelAttachment}
                  className="flex-shrink-0 p-1 rounded-full hover:bg-[var(--surface-strong)] transition-colors"
                  aria-label="Remove attachment"
                >
                  <svg className="w-4 h-4 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            {replyingTo && (
              <div className="mb-3 flex items-start gap-3 px-4 py-2.5 rounded-[var(--radius-md)] bg-[var(--surface-alt)] border border-[var(--border)]">
                <div className="flex-1 min-w-0 pl-3 border-l-2 border-[var(--accent)]">
                  <p className="text-[11px] font-semibold text-[var(--accent)] uppercase tracking-[0.06em] mb-0.5">
                    {replyingTo.senderId === userId
                      ? "You"
                      : usernameById[replyingTo.senderId] || "Unknown"}
                  </p>
                  <p className="text-[12px] text-[var(--text-secondary)] truncate">
                    {replyingTo.content.length > 100
                      ? replyingTo.content.slice(0, 100) + "\u2026"
                      : replyingTo.content}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyingTo(null)}
                  className="flex-shrink-0 p-1 rounded-full hover:bg-[var(--surface-strong)] transition-colors"
                  aria-label="Cancel reply"
                >
                  <svg className="w-4 h-4 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            {showOptions && (
              <div className="mb-3 px-1">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                  Auto-delete
                </p>
                <div className="flex flex-wrap gap-2">
                  {TIMER_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        setSelfDestructTime(opt.value);
                        setShowOptions(false);
                      }}
                      className={`px-3 py-1.5 rounded-full border text-[12px] transition-colors ${
                        selfDestructTime === opt.value
                          ? "bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]"
                          : "bg-[var(--surface-strong)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <textarea
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={hasMembersToSend ? "Type message..." : "Add members to start chatting"}
                  rows={1}
                  maxLength={10000}
                  disabled={!hasMembersToSend}
                  aria-label="Group message input"
                  className="w-full px-4 py-3 bg-[var(--surface-strong)] rounded-full border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] resize-none shadow-[var(--shadow-sm)] text-[16px] leading-snug disabled:opacity-60"
                  style={{ minHeight: "48px", maxHeight: "140px" }}
                />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelect}
                accept="image/*,.pdf,.doc,.docx,.txt,.zip"
                className="hidden"
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!hasMembersToSend}
                className="w-12 h-12 rounded-full bg-[var(--surface-strong)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center flex-shrink-0"
                aria-label="Attach file"
                title="Attach file"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setShowOptions((v) => !v)}
                disabled={!hasMembersToSend}
                className={`w-12 h-12 rounded-full border transition-colors inline-flex items-center justify-center flex-shrink-0 disabled:opacity-60 disabled:cursor-not-allowed ${
                  selfDestructTime
                    ? "bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]"
                    : "bg-[var(--surface-strong)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
                aria-label="Self-destruct timer"
                title={
                  selfDestructTime
                    ? `Auto-delete: ${formatTimerLabel(selfDestructTime)}`
                    : "Self-destruct timer"
                }
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v5l3 2" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={
                  (!messageText.trim() && !pendingAttachment) ||
                  sending ||
                  !hasMembersToSend
                }
                className="w-12 h-12 rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] border border-[var(--border)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center flex-shrink-0 shadow-[var(--shadow-sm)]"
                aria-label="Send"
                title="Send"
              >
                {sending ? (
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                )}
              </button>
            </div>
            {selfDestructTime ? (
              <div className="mt-2 text-center">
                <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Auto-delete in {formatTimerLabel(selfDestructTime)}
                </span>
              </div>
            ) : null}
          </footer>
        </>
      ) : (
        /* Info / members */
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface-strong)]">
              <p className="text-[12px] text-[var(--text-secondary)]">{error}</p>
            </div>
          )}

          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Members
              </h3>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShowAddMember(true)}
                  className="lume-icon-btn"
                  aria-label="Add member"
                  title="Add member"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
                    <circle cx="8.5" cy="7" r="4" strokeWidth="1.8" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M20 8v6M23 11h-6" />
                  </svg>
                </button>
              )}
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] overflow-hidden">
              {group.members.map((member) => {
                const isSelf = member.user_id === userId;
                const memberIsAdmin = member.role === "admin";
                const canRemove = isAdmin && !memberIsAdmin && !isSelf;
                const isRemoving = removingId === member.user_id;

                return (
                  <div
                    key={member.user_id}
                    className="px-4 py-3 flex items-center gap-3 border-b border-[var(--border)]/40 last:border-b-0"
                  >
                    <Avatar username={member.username} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-[var(--text-primary)] truncate">
                          @{member.username}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-[0.1em]">
                            you
                          </span>
                        )}
                      </div>
                      {memberIsAdmin && (
                        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
                          Admin
                        </span>
                      )}
                    </div>
                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => void handleRemoveMember(member.user_id)}
                        disabled={isRemoving}
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                        aria-label={`Remove ${member.username}`}
                        title={`Remove ${member.username}`}
                      >
                        {isRemoving ? (
                          <div className="w-4 h-4 border-2 mono-spinner rounded-full animate-spin" />
                        ) : (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] mb-3">
              Info
            </h3>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[var(--text-muted)]">Created</span>
                <span className="text-[12px] text-[var(--text-secondary)]">
                  {new Date(group.created_at).toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>
            </div>
          </div>

          <Button
            variant="danger"
            fullWidth
            onClick={() => void handleLeaveGroup()}
            loading={leavingGroup}
          >
            Leave Group
          </Button>
        </div>
      )}

      <AddMemberModal
        isOpen={showAddMember}
        onClose={() => setShowAddMember(false)}
        group={group}
      />
    </div>
  );
}
