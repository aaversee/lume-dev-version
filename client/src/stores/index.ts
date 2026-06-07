/**
 * Глобальное состояние приложения
 * Zustand store для управления аутентификацией, контактами, чатами
 */

import { create } from "zustand";
import type { Contact } from "@/crypto/storage";
import { vaultClear, vaultSetSessions, vaultUpsertSession, vaultDeleteSession } from "@/crypto/keyVault";
import type { SerializedSession } from "@/crypto/ratchet";

// ==================== Auth Store ====================

interface AuthState {
  isAuthenticated: boolean;
  userId: string | null;
  username: string | null;
  /** Whether the vault holds identity keys (UI guard — no key material in store). */
  hasIdentityKeys: boolean;
  /** Whether this user is discoverable by username. */
  discoverable: boolean;

  // Actions
  setAuth: (userId: string, username: string) => void;
  clearAuth: () => void;
  setDiscoverable: (value: boolean) => void;
}

// SECURITY: Private key material lives in the vault (crypto/keyVault.ts), not here.
// This store holds only public data and boolean flags for UI reactivity.
export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  userId: null,
  username: null,
  hasIdentityKeys: false,
  discoverable: true,

  setAuth: (userId, username) =>
    set({ isAuthenticated: true, userId, username, hasIdentityKeys: true }),

  clearAuth: () => {
    vaultClear();
    set({
      isAuthenticated: false,
      userId: null,
      username: null,
      hasIdentityKeys: false,
      discoverable: true,
    });
  },

  setDiscoverable: (value) => set({ discoverable: value }),
}));

// ==================== Contacts Store ====================

interface ContactsState {
  contacts: Contact[];

  // Actions
  setContacts: (contacts: Contact[]) => void;
  addContact: (contact: Contact) => void;
  removeContact: (id: string) => void;
  updateContact: (id: string, updates: Partial<Contact>) => void;
}

export const useContactsStore = create<ContactsState>()((set) => ({
  contacts: [],

  setContacts: (contacts) => set({ contacts }),

  addContact: (contact) =>
    set((state) => ({ contacts: [...state.contacts, contact] })),

  removeContact: (id) =>
    set((state) => ({
      contacts: state.contacts.filter((c) => c.id !== id),
    })),

  updateContact: (id, updates) =>
    set((state) => ({
      contacts: state.contacts.map((c) =>
        c.id === id ? { ...c, ...updates } : c,
      ),
    })),
}));

// ==================== Sessions Store (Double Ratchet) ====================

interface SessionsState {
  /** Contact IDs with active ratchet sessions (no key material — vault holds sessions). */
  sessionContactIds: string[];

  setSessions: (sessions: Record<string, SerializedSession>) => void;
  upsertSession: (contactId: string, session: SerializedSession) => void;
  deleteSession: (contactId: string) => void;
}

export const useSessionsStore = create<SessionsState>()((set) => ({
  sessionContactIds: [],

  setSessions: (sessions) => {
    vaultSetSessions(sessions);
    set({ sessionContactIds: Object.keys(sessions) });
  },

  upsertSession: (contactId, session) => {
    vaultUpsertSession(contactId, session);
    set((state) => {
      if (state.sessionContactIds.includes(contactId)) return state;
      return { sessionContactIds: [...state.sessionContactIds, contactId] };
    });
  },

  deleteSession: (contactId) => {
    vaultDeleteSession(contactId);
    set((state) => {
      if (!state.sessionContactIds.includes(contactId)) return state;
      return {
        sessionContactIds: state.sessionContactIds.filter(
          (id) => id !== contactId,
        ),
      };
    });
  },

}));

// ==================== Chat Store ====================

export interface MessageReplyRef {
  messageId: string;
  content: string;
  senderId: string;
}

export interface MessageAttachment {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  /** NaCl secretbox key (base64) — needed to decrypt the file */
  key: string;
  /** NaCl secretbox nonce (base64) */
  nonce: string;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  content: string;
  type: "text" | "image" | "video" | "file" | "voice";
  timestamp: number;
  status: "sending" | "sent" | "delivered" | "read" | "failed";
  selfDestructAt?: number;
  isDeleted?: boolean;
  replyTo?: MessageReplyRef;
  attachment?: MessageAttachment;
}

export interface Chat {
  id: string;
  contactId: string;
  messages: Message[];
  unreadCount: number;
  lastMessage?: Message;
  isHidden: boolean;
  selfDestructTimer?: number; // секунды
}

interface ChatsState {
  chats: Chat[];
  activeChatId: string | null;

  // Actions
  setChats: (chats: Chat[]) => void;
  setActiveChat: (chatId: string | null) => void;
  addChat: (chat: Chat) => void;
  addMessage: (chatId: string, message: Message) => void;
  updateMessage: (
    chatId: string,
    messageId: string,
    updates: Partial<Message>,
  ) => void;
  batchUpdateMessageStatus: (
    chatId: string,
    messageIds: string[],
    status: Message["status"],
  ) => void;
  markAsRead: (chatId: string) => void;
  deleteMessage: (chatId: string, messageId: string) => void;
  deleteChat: (chatId: string) => void;
  setChatHidden: (chatId: string, hidden: boolean) => void;
  setSelfDestructTimer: (chatId: string, timer: number | undefined) => void;
  pruneExpiredMessages: (now?: number) => void;
}

const MAX_MESSAGES_PER_CHAT = 200;

export const useChatsStore = create<ChatsState>()((set, get) => ({
  chats: [],
  activeChatId: null,

  setChats: (chats) => set({ chats }),

  setActiveChat: (chatId) => set({ activeChatId: chatId }),

  addChat: (chat) => set((state) => ({ chats: [...state.chats, chat] })),

  addMessage: (chatId, message) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id !== chatId
          ? chat
          : (() => {
              if (
                chat.messages.some((existing) => existing.id === message.id)
              ) {
                return chat;
              }

              const isActiveChat = get().activeChatId === chatId;
              return {
                ...chat,
                messages: [...chat.messages, message].slice(
                  -MAX_MESSAGES_PER_CHAT,
                ),
                lastMessage: message,
                unreadCount: isActiveChat
                  ? chat.unreadCount
                  : chat.unreadCount + 1,
              };
            })(),
      ),
    })),

  updateMessage: (chatId, messageId, updates) =>
    set((state) => {
      const chatIndex = state.chats.findIndex((c) => c.id === chatId);
      if (chatIndex === -1) return state;

      const chat = state.chats[chatIndex]!;
      const msgIndex = chat.messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return state;

      const msg = chat.messages[msgIndex]!;
      // Check if anything actually changed
      const changed = Object.entries(updates).some(
        ([key, val]) => msg[key as keyof typeof msg] !== val,
      );
      if (!changed) return state;

      const newMessages = [...chat.messages];
      newMessages[msgIndex] = { ...msg, ...updates };

      const lastMessage =
        chat.lastMessage?.id === messageId
          ? { ...chat.lastMessage, ...updates }
          : chat.lastMessage;

      const newChats = [...state.chats];
      newChats[chatIndex] = { ...chat, messages: newMessages, lastMessage };

      return { chats: newChats };
    }),

  batchUpdateMessageStatus: (chatId, messageIds, status) =>
    set((state) => {
      const idSet = new Set(messageIds);
      return {
        chats: state.chats.map((chat) =>
          chat.id !== chatId
            ? chat
            : (() => {
                const messages = chat.messages.map((msg) =>
                  idSet.has(msg.id) ? { ...msg, status } : msg,
                );
                const lastMessage =
                  chat.lastMessage && idSet.has(chat.lastMessage.id)
                    ? { ...chat.lastMessage, status }
                    : chat.lastMessage;
                return { ...chat, messages, lastMessage };
              })(),
        ),
      };
    }),

  markAsRead: (chatId) =>
    set((state) => {
      const target = state.chats.find((c) => c.id === chatId);
      if (!target || target.unreadCount === 0) return state;
      return {
        chats: state.chats.map((chat) =>
          chat.id === chatId ? { ...chat, unreadCount: 0 } : chat,
        ),
      };
    }),

  deleteMessage: (chatId, messageId) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id !== chatId
          ? chat
          : (() => {
              const messages = chat.messages.filter(
                (msg) => msg.id !== messageId,
              );
              const lastMessage =
                messages.length > 0 ? messages[messages.length - 1] : undefined;
              return { ...chat, messages, lastMessage };
            })(),
      ),
    })),

  deleteChat: (chatId) =>
    set((state) => ({
      chats: state.chats.filter((chat) => chat.id !== chatId),
      activeChatId: state.activeChatId === chatId ? null : state.activeChatId,
    })),

  setChatHidden: (chatId, hidden) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? { ...chat, isHidden: hidden } : chat,
      ),
    })),

  setSelfDestructTimer: (chatId, timer) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? { ...chat, selfDestructTimer: timer } : chat,
      ),
    })),

  pruneExpiredMessages: (now = Date.now()) =>
    set((state) => ({
      chats: state.chats.map((chat) => {
        const nextMessages = chat.messages.filter(
          (msg) => !msg.selfDestructAt || msg.selfDestructAt > now,
        );
        if (nextMessages.length === chat.messages.length) {
          return chat;
        }
        const lastMessage =
          nextMessages.length > 0
            ? nextMessages[nextMessages.length - 1]
            : undefined;
        return {
          ...chat,
          messages: nextMessages,
          lastMessage,
          unreadCount: Math.min(chat.unreadCount, nextMessages.length),
        };
      }),
    })),
}));

// ==================== UI Store ====================

interface UIState {
  isPanicMode: boolean;
  showHiddenChats: boolean;
  isOnline: boolean;
  wsConnected: boolean;
  wsStatus:
    | "connected"
    | "connecting"
    | "disconnected"
    | "rate_limited"
    | "kicked"
    | "auth_error";
  contactsPanelCollapsed: boolean;
  cryptoBanner: {
    level: "info" | "warning" | "error";
    message: string;
    updatedAt: number;
  } | null;

  // Actions
  setPanicMode: (active: boolean) => void;
  setShowHiddenChats: (show: boolean) => void;
  setContactsPanelCollapsed: (collapsed: boolean) => void;
  setOnline: (online: boolean) => void;
  setWsConnected: (connected: boolean) => void;
  setWsStatus: (status: UIState["wsStatus"]) => void;
  setCryptoBanner: (banner: {
    level: "info" | "warning" | "error";
    message: string;
  }) => void;
  clearCryptoBanner: () => void;
}

export const useUIStore = create<UIState>()((set) => ({
  isPanicMode: false,
  showHiddenChats: false,
  contactsPanelCollapsed: typeof window !== "undefined" && localStorage.getItem("lume:contacts-collapsed") === "true",
  isOnline: true,
  wsConnected: false,
  wsStatus: "disconnected",
  cryptoBanner: null,

  setPanicMode: (active) => set({ isPanicMode: active }),
  setShowHiddenChats: (show) => set({ showHiddenChats: show }),
  setContactsPanelCollapsed: (collapsed) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("lume:contacts-collapsed", String(collapsed));
    }
    set({ contactsPanelCollapsed: collapsed });
  },
  setOnline: (online) => set({ isOnline: online }),
  setWsConnected: (connected) =>
    set({
      wsConnected: connected,
      wsStatus: connected ? "connected" : "disconnected",
    }),
  setWsStatus: (status) =>
    set({ wsStatus: status, wsConnected: status === "connected" }),
  setCryptoBanner: (banner) =>
    set((state) => {
      const now = Date.now();
      // Prevent UI thrash if a loop repeatedly reports the same crypto issue.
      if (
        state.cryptoBanner?.message === banner.message &&
        now - state.cryptoBanner.updatedAt < 10000
      ) {
        return state;
      }
      return { cryptoBanner: { ...banner, updatedAt: now } };
    }),
  clearCryptoBanner: () => set({ cryptoBanner: null }),
}));

// ==================== Typing Store ====================

interface TypingState {
  /** contactId -> true if currently typing */
  typingUsers: Record<string, boolean>;
  /** groupId -> { senderId -> true } for members typing in a group */
  groupTypingUsers: Record<string, Record<string, boolean>>;

  setTyping: (contactId: string, isTyping: boolean) => void;
  setGroupTyping: (
    groupId: string,
    senderId: string,
    isTyping: boolean,
  ) => void;
  clearAll: () => void;
}

export const useTypingStore = create<TypingState>()((set) => ({
  typingUsers: {},
  groupTypingUsers: {},

  setTyping: (contactId, isTyping) =>
    set((state) => {
      if (isTyping) {
        return { typingUsers: { ...state.typingUsers, [contactId]: true } };
      }
      if (!(contactId in state.typingUsers)) return state;
      const next = { ...state.typingUsers };
      delete next[contactId];
      return { typingUsers: next };
    }),

  setGroupTyping: (groupId, senderId, isTyping) =>
    set((state) => {
      const current = state.groupTypingUsers[groupId] ?? {};
      if (isTyping) {
        return {
          groupTypingUsers: {
            ...state.groupTypingUsers,
            [groupId]: { ...current, [senderId]: true },
          },
        };
      }
      if (!(senderId in current)) return state;
      const nextGroup = { ...current };
      delete nextGroup[senderId];
      return {
        groupTypingUsers: {
          ...state.groupTypingUsers,
          [groupId]: nextGroup,
        },
      };
    }),

  clearAll: () => set({ typingUsers: {}, groupTypingUsers: {} }),
}));

// ==================== Blocked Store ====================

interface BlockedState {
  /** Map of blocked contact IDs → true */
  blockedIds: Record<string, true>;

  setBlockedIds: (ids: string[]) => void;
  addBlocked: (id: string) => void;
  removeBlocked: (id: string) => void;
  isBlocked: (id: string) => boolean;
}

export { useGroupsStore } from "./groups";

export const useBlockedStore = create<BlockedState>()((set, get) => ({
  blockedIds: {},

  setBlockedIds: (ids) => {
    const map: Record<string, true> = {};
    for (const id of ids) map[id] = true;
    set({ blockedIds: map });
  },

  addBlocked: (id) =>
    set((state) => {
      if (state.blockedIds[id]) return state;
      return { blockedIds: { ...state.blockedIds, [id]: true } };
    }),

  removeBlocked: (id) =>
    set((state) => {
      if (!state.blockedIds[id]) return state;
      const next = { ...state.blockedIds };
      delete next[id];
      return { blockedIds: next };
    }),

  isBlocked: (id) => !!get().blockedIds[id],
}));
