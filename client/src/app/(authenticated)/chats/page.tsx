/**
 * Messenger: chats list / dashboard shell (desktop)
 * Mobile shows only the chats list.
 */

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import MessengerShell from "@/components/messenger/MessengerShell";
import MobileSwipeShell from "@/components/messenger/MobileSwipeShell";
import LeftRail from "@/components/messenger/LeftRail";
import ChatListPanel from "@/components/messenger/ChatListPanel";
import RightRail from "@/components/messenger/RightRail";
import { ChatListSkeleton } from "@/components/ui";
import GroupView from "@/components/chat/GroupView";
import dynamic from "next/dynamic";

const AddContactModal = dynamic(
  () =>
    import("@/components/modals").then((m) => ({ default: m.AddContactModal })),
  { ssr: false },
);
const BackupModal = dynamic(
  () => import("@/components/modals").then((m) => ({ default: m.BackupModal })),
  { ssr: false },
);
const CreateGroupModal = dynamic(
  () =>
    import("@/components/modals").then((m) => ({
      default: m.CreateGroupModal,
    })),
  { ssr: false },
);
const PanicModal = dynamic(
  () => import("@/components/modals").then((m) => ({ default: m.PanicModal })),
  { ssr: false },
);
import { useHydrated } from "@/hooks/useMessengerSync";
import { useContactActions } from "@/hooks/useContactActions";
import { usePanic } from "@/hooks/usePanic";
import { groupsApi } from "@/lib/api";
import {
  useAuthStore,
  useContactsStore,
  useChatsStore,
  useGroupsStore,
} from "@/stores";
import { useContactAvatars } from "@/hooks/useContactAvatars";

export default function ChatsPage() {
  const router = useRouter();

  const hydrated = useHydrated();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasIdentityKeys = useAuthStore((s) => s.hasIdentityKeys);
  const contacts = useContactsStore((s) => s.contacts);
  const chats = useChatsStore((s) => s.chats);
  const activeChatId = useChatsStore((s) => s.activeChatId);
  const setActiveChat = useChatsStore((s) => s.setActiveChat);
  const { groups, activeGroupId, setGroups, setActiveGroup } = useGroupsStore();
  const avatarMap = useContactAvatars(contacts);

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
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  // Auth guard — redirect in useEffect to avoid render-phase side effects.
  useEffect(() => {
    if (hydrated && !isAuthenticated) {
      router.push("/");
    }
  }, [hydrated, isAuthenticated, router]);

  // Fetch groups on mount / when identity keys become available
  useEffect(() => {
    if (!hasIdentityKeys) return;
    void (async () => {
      const result = await groupsApi.list();
      if (result.data?.groups) {
        setGroups(result.data.groups);
      }
    })();
  }, [hasIdentityKeys, setGroups]);

  if (!hydrated) {
    return (
      <MessengerShell
        leftRail={<div className="h-full" />}
        chatList={<ChatListSkeleton />}
        main={
          <div
            aria-busy="true"
            className="lume-panel h-full rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] flex items-center justify-center"
          >
            <div className="w-8 h-8 border-2 mono-spinner rounded-full animate-spin" />
          </div>
        }
      />
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  const handleSelectChat = (chatId: string) => {
    if (!chatId) {
      // Called when switching to groups tab — clear individual chat selection
      setActiveChat(null);
      return;
    }
    setActiveGroup(null);
    setActiveChat(chatId);
    router.push(`/chat/${chatId}`);
  };

  const activeGroup = activeGroupId
    ? (groups.find((g) => g.id === activeGroupId) ?? null)
    : null;

  if (isPanicMode) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[var(--text-secondary)] uppercase tracking-[0.18em] text-sm">
          No messages
        </p>
      </div>
    );
  }

  const emptyMain = (
    <div className="lume-panel h-full min-h-0 rounded-[var(--radius-lg)] border border-[var(--border)] shadow-[var(--shadow-sm)] overflow-hidden">
      <div className="h-full flex flex-col items-center justify-center px-8 text-center">
        <div className="w-16 h-16 rounded-full border border-[var(--border)] bg-[var(--surface-strong)] shadow-[var(--shadow-sm)] flex items-center justify-center text-[var(--text-muted)]">
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
        <h3 className="mt-5 text-[14px] font-semibold uppercase tracking-[0.14em] text-[var(--text-primary)]">
          Select a chat
        </h3>
        <p className="mt-2 text-[12px] text-[var(--text-muted)] max-w-sm">
          Choose a conversation from the list or start a new one.
        </p>
        <div className="mt-6 w-full max-w-xs">
          <button
            className="apple-button"
            onClick={() => setShowAddContact(true)}
          >
            Start Chat
          </button>
        </div>
      </div>
    </div>
  );

  const mainContent = activeGroup ? (
    <GroupView group={activeGroup} />
  ) : (
    emptyMain
  );

  const chatListNode = (
    <ChatListPanel
      chats={chats}
      contacts={contacts}
      selectedChatId={activeChatId}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onSelectChat={handleSelectChat}
      onNewChat={() => setShowAddContact(true)}
      onNewGroup={() => setShowCreateGroup(true)}
      avatarMap={avatarMap}
    />
  );

  const leftRailNode = (
    <LeftRail
      onPanic={() => setShowPanicConfirm(true)}
      onOpenBackup={() => setShowBackupModal(true)}
    />
  );

  return (
    <div className="h-[100dvh] w-full overflow-hidden">
      {/* Mobile: swipeable Profile + Messages panels */}
      <div className="md:hidden h-full min-h-0 p-2 sm:p-3">
        <MobileSwipeShell
          profilePanel={leftRailNode}
          chatListPanel={chatListNode}
        />
      </div>

      {/* Desktop: 4-column dashboard like the reference */}
      <div className="hidden md:block h-full min-h-0">
        <MessengerShell
          leftRail={leftRailNode}
          chatList={chatListNode}
          main={mainContent}
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

      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
      />

      <BackupModal
        isOpen={showBackupModal}
        onClose={() => setShowBackupModal(false)}
      />
    </div>
  );
}
