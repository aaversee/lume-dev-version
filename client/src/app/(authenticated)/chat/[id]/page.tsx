/**
 * Messenger: active chat view inside the dashboard shell (desktop).
 * Mobile shows chat only with a back button.
 */

"use client";

import { useEffect, useRef, useState, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import MessengerShell from "@/components/messenger/MessengerShell";
import LeftRail from "@/components/messenger/LeftRail";
import ChatListPanel from "@/components/messenger/ChatListPanel";
import RightRail from "@/components/messenger/RightRail";
import { ChatListSkeleton, MessagesSkeleton } from "@/components/ui";
import dynamic from "next/dynamic";
import {
  ChatHeader,
  ChatInput,
  MessageBubbleMemo,
  ProfileModal,
} from "@/components/chat";

const AddContactModal = dynamic(
  () =>
    import("@/components/modals").then((m) => ({ default: m.AddContactModal })),
  { ssr: false },
);
const BackupModal = dynamic(
  () => import("@/components/modals").then((m) => ({ default: m.BackupModal })),
  { ssr: false },
);
const PanicModal = dynamic(
  () => import("@/components/modals").then((m) => ({ default: m.PanicModal })),
  { ssr: false },
);
import { useHydrated } from "@/hooks/useMessengerSync";
import { useContactActions } from "@/hooks/useContactActions";
import { usePanic } from "@/hooks/usePanic";
import {
  useAuthStore,
  useContactsStore,
  useChatsStore,
  useSessionsStore,
  useUIStore,
  useTypingStore,
  useBlockedStore,
  type Message,
} from "@/stores";
import { messagesApi, authApi, filesApi, profileApi } from "@/lib/api";
import { downloadAndCacheAvatar, getCachedAvatarUrl } from "@/lib/avatarCache";
import { useContactAvatars } from "@/hooks/useContactAvatars";
import { wsClient } from "@/lib/websocket";
import { decodeBase64 } from "tweetnacl-util";
import { verify } from "@/crypto/keys";
import { encodeRatchetEnvelope } from "@/lib/ratchetPayload";
import {
  deserializeSession,
  initSenderSession,
  ratchetEncrypt,
  serializeSession,
  x3dhInitiate,
} from "@/crypto/ratchet";
import { computeSafetyNumber } from "@/crypto/safetyNumber";
import {
  vaultGetSession,
  vaultGetExchangeKeyPair,
  vaultGetPublicKeys,
  vaultHasKeys,
} from "@/crypto/keyVault";
import type { PendingAttachment } from "@/components/chat/ChatInput";
import {
  encryptFile,
  readFileAsUint8Array,
  isImageMime,
} from "@/lib/fileEncryption";
import type { MessageAttachment } from "@/stores";

interface ChatPageProps {
  params: Promise<{ id: string }>;
}

export default function ChatPage({ params }: ChatPageProps) {
  const { id: chatId } = use(params);
  const router = useRouter();
  const hydrated = useHydrated();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStateRef = useRef(false);

  const userId = useAuthStore((s) => s.userId);
  const hasKeys = useAuthStore((s) => s.hasIdentityKeys);
  const contacts = useContactsStore((s) => s.contacts);
  const removeContact = useContactsStore((s) => s.removeContact);
  const avatarMap = useContactAvatars(contacts);
  const upsertSession = useSessionsStore((s) => s.upsertSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const chats = useChatsStore((s) => s.chats);
  const addMessage = useChatsStore((s) => s.addMessage);
  const updateMessage = useChatsStore((s) => s.updateMessage);
  const deleteMessage = useChatsStore((s) => s.deleteMessage);
  const deleteChat = useChatsStore((s) => s.deleteChat);
  const setChatHidden = useChatsStore((s) => s.setChatHidden);
  const markAsRead = useChatsStore((s) => s.markAsRead);
  const setSelfDestructTimer = useChatsStore((s) => s.setSelfDestructTimer);
  const activeChatId = useChatsStore((s) => s.activeChatId);
  const setActiveChat = useChatsStore((s) => s.setActiveChat);
  const setCryptoBanner = useUIStore((s) => s.setCryptoBanner);
  const clearCryptoBanner = useUIStore((s) => s.clearCryptoBanner);
  const showHiddenChats = useUIStore((s) => s.showHiddenChats);
  const setShowHiddenChats = useUIStore((s) => s.setShowHiddenChats);

  const {
    showAddContact,
    setShowAddContact,
    newContactUsername,
    setNewContactUsername,
    addContactError,
    addContactLoading,
    handleAddContact,
    openChatForContact,
    resetAddContact,
  } = useContactActions();

  const { isPanicMode, showPanicConfirm, setShowPanicConfirm, executePanic } =
    usePanic();

  const [searchQuery, setSearchQuery] = useState("");
  const [showBackupModal, setShowBackupModal] = useState(false);

  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [selfDestructTime, setSelfDestructTime] = useState<number | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pendingAttachment, setPendingAttachment] =
    useState<PendingAttachment | null>(null);
  const [contactAvatarUrl, setContactAvatarUrl] = useState<string | null>(null);

  const isValidChatId =
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
      chatId,
    );
  const chat = isValidChatId ? chats.find((c) => c.id === chatId) : undefined;
  const contact = contacts.find((c) => c.id === chat?.contactId);
  const contactId = contact?.id;

  const isContactBlocked = useBlockedStore((s) =>
    contactId ? !!s.blockedIds[contactId] : false,
  );

  const isTyping = useTypingStore((s) =>
    contactId ? (s.typingUsers[contactId] ?? false) : false,
  );
  const pubKeys = vaultGetPublicKeys();
  const safetyNumber =
    pubKeys && contact
      ? computeSafetyNumber({
          mySigningPublicKey: pubKeys.signingPublicKey,
          myExchangeIdentityPublicKey: pubKeys.exchangePublicKey,
          theirSigningPublicKey: contact.publicKey,
          theirExchangeIdentityPublicKey: contact.exchangeKey,
        })
      : null;

  // Load contact avatar
  useEffect(() => {
    if (!contactId || !hasKeys) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await profileApi.get(contactId);
        if (cancelled || !res.data?.avatarFileId) return;

        const fid = res.data.avatarFileId;
        const cached = getCachedAvatarUrl(fid);
        if (cached) {
          setContactAvatarUrl(cached);
          return;
        }

        const url = await downloadAndCacheAvatar(fid, async () => {
          const r = await filesApi.download(fid);
          if (!r.data) return null;
          return { data: r.data.data, mimeHint: r.data.mimeHint };
        });
        if (!cancelled) setContactAvatarUrl(url);
      } catch {
        // Best effort
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contactId, hasKeys]);

  useEffect(() => {
    if (!hydrated) return;
    setActiveChat(chatId);
    markAsRead(chatId);

    // Send read receipts for unread messages from the contact
    if (contactId) {
      const currentChat = useChatsStore
        .getState()
        .chats.find((c) => c.id === chatId);
      if (currentChat) {
        const unreadFromContact = currentChat.messages.filter(
          (m) => m.senderId === contactId && m.status !== "read",
        );
        if (unreadFromContact.length > 0) {
          wsClient.sendReadReceipt(
            contactId,
            unreadFromContact.map((m) => m.id),
          );
        }
      }
    }
  }, [hydrated, chatId, contactId, markAsRead, setActiveChat]);

  useEffect(() => {
    if (!chat) return;
    if (
      selfDestructTime === null &&
      typeof chat.selfDestructTimer === "number"
    ) {
      setSelfDestructTime(chat.selfDestructTimer);
    }
  }, [chat, selfDestructTime]);

  useEffect(() => {
    if (!hydrated || !chat) return;
    if (chat.isHidden && !showHiddenChats) {
      router.push("/chats");
    }
  }, [hydrated, chat, showHiddenChats, router]);

  useEffect(() => {
    if (!hydrated) return;
    if (!userId || !hasKeys) {
      router.push("/unlock");
    }
  }, [hydrated, userId, hasKeys, router]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }
    // Only auto-scroll if the user is already near the bottom (within 120px).
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      120;
    if (isNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [chat?.messages.length]);

  // Reduce WS traffic: send typing=true once when user starts typing,
  // then typing=false after a short inactivity window.
  useEffect(() => {
    if (!contactId) return undefined;

    const isTypingNow = messageText.trim().length > 0;

    if (!isTypingNow) {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (typingStateRef.current) {
        typingStateRef.current = false;
        wsClient.sendTyping(contactId, false);
      }
      return undefined;
    }

    if (!typingStateRef.current) {
      typingStateRef.current = true;
      wsClient.sendTyping(contactId, true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      typingTimeoutRef.current = null;
      if (typingStateRef.current) {
        typingStateRef.current = false;
        wsClient.sendTyping(contactId, false);
      }
    }, 1200);

    return undefined;
  }, [messageText, contactId]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (contactId && typingStateRef.current) {
        typingStateRef.current = false;
        wsClient.sendTyping(contactId, false);
      }
    };
  }, [contactId]);

  const handleAttach = useCallback((file: File) => {
    const preview = isImageMime(file.type)
      ? URL.createObjectURL(file)
      : undefined;
    setPendingAttachment({ file, preview });
  }, []);

  const handleCancelAttachment = useCallback(() => {
    if (pendingAttachment?.preview) {
      URL.revokeObjectURL(pendingAttachment.preview);
    }
    setPendingAttachment(null);
  }, [pendingAttachment]);

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      if (chatId) {
        deleteMessage(chatId, messageId);
      }
    },
    [chatId, deleteMessage],
  );

  const handleReply = useCallback((message: Message) => {
    setReplyingTo(message);
  }, []);

  const handleSend = async () => {
    const hasText = messageText.trim().length > 0;
    const hasAttachment = !!pendingAttachment;
    if ((!hasText && !hasAttachment) || !contact || !userId || !hasKeys)
      return;

    setSending(true);

    const messageId = uuidv4();
    const timestamp = Date.now();
    const outgoingText = messageText;

    // Upload and encrypt file attachment if present
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
          await filesApi.upload(
            encrypted.ciphertext,
            encrypted.mimeType,
          );
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
      } catch (err) {
        if (process.env.NODE_ENV !== "production")
          console.error("File upload error:", err);
        setSending(false);
        return;
      }
    }

    const msgType = attachmentMeta
      ? isImageMime(attachmentMeta.mimeType)
        ? "image"
        : "file"
      : "text";

    const message: Message = {
      id: messageId,
      chatId,
      senderId: userId,
      content: outgoingText,
      type: msgType as Message["type"],
      timestamp,
      status: "sending",
      selfDestructAt: selfDestructTime
        ? timestamp + selfDestructTime * 1000
        : undefined,
      replyTo: replyingTo
        ? {
            messageId: replyingTo.id,
            content: replyingTo.content,
            senderId: replyingTo.senderId,
          }
        : undefined,
      attachment: attachmentMeta,
    };

    addMessage(chatId, message);
    setMessageText("");
    setReplyingTo(null);
    if (pendingAttachment?.preview) {
      URL.revokeObjectURL(pendingAttachment.preview);
    }
    setPendingAttachment(null);

    try {
      const replyRef = replyingTo
        ? {
            messageId: replyingTo.id,
            content: replyingTo.content.slice(0, 200),
            senderId: replyingTo.senderId,
          }
        : undefined;
      const plaintext = JSON.stringify({
        content: outgoingText,
        timestamp,
        selfDestruct: selfDestructTime ?? null,
        ...(replyRef ? { replyTo: replyRef } : {}),
        ...(attachmentMeta ? { attachment: attachmentMeta } : {}),
      });
      const plaintextBytes = new TextEncoder().encode(plaintext);

      const existing = contactId ? vaultGetSession(contactId) : undefined;

      let session = existing ? deserializeSession(existing) : null;
      let x3dhInit:
        | {
            senderIdentityKey: string;
            senderEphemeralKey: string;
            recipientOneTimePreKey?: string | null;
          }
        | undefined;

      if (!session) {
        // First message to this contact: do X3DH (bundle is signed) and start a ratchet session.
        const { data: bundle, error: bundleError } = await authApi.getBundle(
          contact.username,
        );
        if (bundleError || !bundle) {
          throw new Error(bundleError || "Failed to fetch bundle");
        }

        const ok = verify(
          decodeBase64(bundle.signedPrekey),
          decodeBase64(bundle.signedPrekeySignature),
          bundle.identityKey,
        );
        if (!ok) {
          throw new Error("Invalid signed prekey signature");
        }

        const recipientIk = bundle.exchangeIdentityKey || bundle.exchangeKey;
        if (!recipientIk) {
          throw new Error("Recipient bundle missing exchange identity key");
        }

        const { sharedSecret, ephemeralPublicKey } = x3dhInitiate(
          vaultGetExchangeKeyPair(),
          {
            identityKey: recipientIk,
            signingKey: bundle.identityKey,
            signedPreKey: bundle.signedPrekey,
            signature: bundle.signedPrekeySignature,
            oneTimePreKey: bundle.oneTimePrekey,
          },
        );

        session = initSenderSession(sharedSecret, bundle.signedPrekey);
        x3dhInit = {
          senderIdentityKey: vaultGetPublicKeys()!.exchangePublicKey,
          senderEphemeralKey: ephemeralPublicKey,
          recipientOneTimePreKey: bundle.oneTimePrekey ?? null,
        };
      }

      const encrypted = ratchetEncrypt(session, plaintextBytes);
      const encryptedPayload = encodeRatchetEnvelope({
        encrypted,
        timestamp,
        selfDestruct: selfDestructTime,
        ...(x3dhInit ? { x3dh: x3dhInit } : {}),
      });

      if (contactId) {
        upsertSession(contactId, serializeSession(session));
      }

      const { data, error } = await messagesApi.send({
        senderId: userId,
        recipientUsername: contact.username,
        encryptedPayload,
      });

      if (error) {
        updateMessage(chatId, messageId, { status: "failed" });
      } else {
        clearCryptoBanner();
        updateMessage(chatId, messageId, {
          status: data?.delivered ? "delivered" : "sent",
        });
      }
    } catch (sendError) {
      if (process.env.NODE_ENV !== "production")
        console.error("Send message error:", sendError);
      const msg =
        sendError instanceof Error ? sendError.message : String(sendError);
      if (
        msg.includes("bundle") ||
        msg.includes("signed prekey") ||
        msg.includes("signature") ||
        msg.includes("exchange identity") ||
        msg.includes("Sending chain")
      ) {
        setCryptoBanner({
          level: "warning",
          message: "Cannot establish secure session with this contact.",
        });
      }
      updateMessage(chatId, messageId, { status: "failed" });
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

  const handleSelectTimer = (value: number | null) => {
    setSelfDestructTime(value);
    setSelfDestructTimer(chatId, value ?? undefined);
  };

  const handleDeleteContact = () => {
    if (!contact || !contactId) return;
    deleteChat(chatId);
    deleteSession(contactId);
    removeContact(contactId);
    setShowProfile(false);
    router.push("/chats");
  };

  const handleHideChat = () => {
    const nextHidden = !chat?.isHidden;
    setChatHidden(chatId, nextHidden);
    if (nextHidden) {
      setShowHiddenChats(false);
      setShowProfile(false);
      router.push("/chats");
    }
  };

  // ---------- Loading / guard states ----------

  if (!hydrated) {
    return (
      <MessengerShell
        leftRail={<div className="h-full" />}
        chatList={<ChatListSkeleton />}
        main={
          <div
            aria-busy="true"
            className="lume-panel h-full rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] overflow-hidden flex flex-col"
          >
            <div className="px-5 pt-5 pb-4 border-b border-[var(--border)]/70">
              <div className="flex items-center gap-3">
                <span className="block w-10 h-10 rounded-full bg-[var(--surface-alt)] animate-pulse" />
                <span className="block h-3 w-24 rounded-full bg-[var(--surface-alt)] animate-pulse" />
              </div>
            </div>
            <MessagesSkeleton />
          </div>
        }
      />
    );
  }
  if (isPanicMode) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[var(--text-secondary)] uppercase tracking-[0.18em] text-sm">
          No messages
        </p>
      </div>
    );
  }

  if (!chat || !contact) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-[var(--text-secondary)] uppercase tracking-[0.18em] text-sm">
            Chat not found
          </p>
          <button
            onClick={() => router.push("/chats")}
            className="mt-4 apple-button-secondary px-6"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ---------- Subcomponent nodes ----------

  const chatListNode = (
    <ChatListPanel
      chats={chats}
      contacts={contacts}
      selectedChatId={chatId}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onSelectChat={(id) => {
        setActiveChat(id);
        router.push(`/chat/${id}`);
      }}
      onNewChat={() => setShowAddContact(true)}
      avatarMap={avatarMap}
    />
  );

  const chatViewNode = (
    <div className="lume-panel h-full min-h-0 rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] overflow-hidden flex flex-col">
      <ChatHeader
        contact={contact}
        avatarUrl={contactAvatarUrl}
        isTyping={isTyping}
        selfDestructTime={selfDestructTime}
        showOptions={showOptions}
        onBack={() => router.push("/chats")}
        onOpenProfile={() => setShowProfile(true)}
        onToggleOptions={() => setShowOptions((v) => !v)}
        onSelectTimer={handleSelectTimer}
      />

      <main
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 md:px-6 py-4 sm:py-5 space-y-2"
      >
        {chat.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-16 h-16 rounded-full border border-[var(--border)] bg-[var(--surface-strong)] flex items-center justify-center text-[var(--text-muted)]">
              <svg
                className="w-8 h-8"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                  d="M21 15a4 4 0 01-4 4H8l-5 3V7a4 4 0 014-4h10a4 4 0 014 4v8z"
                />
              </svg>
            </div>
            <p className="mt-4 text-[13px] font-semibold text-[var(--text-primary)]">
              No messages yet
            </p>
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">
              Send the first message.
            </p>
          </div>
        ) : (
          <>
            {chat.messages.map((m) => {
              let replyAuthorName: string | undefined;
              if (m.replyTo) {
                if (m.replyTo.senderId === userId) {
                  replyAuthorName = "You";
                } else {
                  replyAuthorName =
                    contacts.find((c) => c.id === m.replyTo!.senderId)
                      ?.username || "Unknown";
                }
              }
              return (
                <MessageBubbleMemo
                  key={m.id}
                  message={m}
                  isMine={m.senderId === userId}
                  onDelete={handleDeleteMessage}
                  onReply={handleReply}
                  replyAuthorName={replyAuthorName}
                />
              );
            })}
            <div ref={messagesEndRef} />
          </>
        )}
      </main>

      <ChatInput
        messageText={messageText}
        sending={sending}
        selfDestructTime={selfDestructTime}
        replyingTo={replyingTo}
        userId={userId}
        contact={contact}
        onMessageChange={setMessageText}
        onSend={() => void handleSend()}
        onKeyDown={handleKeyDown}
        onToggleOptions={() => setShowOptions((v) => !v)}
        onCancelReply={() => setReplyingTo(null)}
        attachment={pendingAttachment}
        onAttach={handleAttach}
        onCancelAttachment={handleCancelAttachment}
      />
    </div>
  );

  return (
    <div className="h-[100dvh] w-full overflow-hidden">
      {/* Mobile: chat only — no horizontal padding so the panel fills edge-to-edge */}
      <div className="md:hidden h-full min-h-0 p-2 sm:p-4">{chatViewNode}</div>

      {/* Desktop: dashboard shell */}
      <div className="hidden md:block h-full min-h-0">
        <MessengerShell
          leftRail={
            <LeftRail
              onPanic={() => setShowPanicConfirm(true)}
              onOpenBackup={() => setShowBackupModal(true)}
            />
          }
          chatList={chatListNode}
          main={chatViewNode}
          rightRail={
            contacts.length > 0 ? (
              <RightRail
                contacts={contacts}
                chats={chats}
                activeChatId={activeChatId}
                onOpenContact={openChatForContact}
                avatarMap={avatarMap}
              />
            ) : undefined
          }
        />
      </div>

      <AddContactModal
        isOpen={showAddContact}
        onClose={resetAddContact}
        username={newContactUsername}
        onUsernameChange={setNewContactUsername}
        error={addContactError}
        loading={addContactLoading}
        onSubmit={handleAddContact}
      />

      <PanicModal
        isOpen={showPanicConfirm}
        onClose={() => setShowPanicConfirm(false)}
        onConfirm={executePanic}
      />

      <ProfileModal
        isOpen={showProfile}
        onClose={() => setShowProfile(false)}
        contact={contact}
        chat={chat}
        safetyNumber={safetyNumber}
        isContactBlocked={isContactBlocked}
        onDeleteContact={handleDeleteContact}
        onHideChat={handleHideChat}
        avatarUrl={contactAvatarUrl}
      />

      <BackupModal
        isOpen={showBackupModal}
        onClose={() => setShowBackupModal(false)}
      />
    </div>
  );
}
