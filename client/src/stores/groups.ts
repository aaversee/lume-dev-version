/**
 * Groups Store — Zustand store for group chat management.
 * Holds group metadata, per-group message history, and unread counts.
 * No key material lives here; group messages are end-to-end encrypted in transit
 * (pairwise fan-out via the 1:1 Double Ratchet sessions) and stored locally
 * encrypted with the master key.
 */

import { create } from 'zustand';
import type { GroupData } from '@/lib/api';
import type { Message } from './index';

const MAX_MESSAGES_PER_GROUP = 200;

interface GroupsState {
  groups: GroupData[];
  activeGroupId: string | null;
  messagesByGroup: Record<string, Message[]>;
  unreadByGroup: Record<string, number>;
  /** groupId -> messageId -> userIds who have read it (for outgoing messages) */
  readsByGroup: Record<string, Record<string, string[]>>;

  setGroups: (groups: GroupData[]) => void;
  addGroup: (group: GroupData) => void;
  updateGroup: (id: string, updates: Partial<GroupData>) => void;
  removeGroup: (id: string) => void;
  setActiveGroup: (id: string | null) => void;

  setGroupMessagesAll: (messagesByGroup: Record<string, Message[]>) => void;
  addGroupMessage: (
    groupId: string,
    message: Message,
    incrementUnread?: boolean,
  ) => void;
  updateGroupMessage: (
    groupId: string,
    messageId: string,
    updates: Partial<Message>,
  ) => void;
  deleteGroupMessage: (groupId: string, messageId: string) => void;
  markGroupRead: (groupId: string) => void;
  recordGroupReads: (
    groupId: string,
    messageIds: string[],
    readerId: string,
    recipientCount: number,
  ) => void;
}

export const useGroupsStore = create<GroupsState>()((set) => ({
  groups: [],
  activeGroupId: null,
  messagesByGroup: {},
  unreadByGroup: {},
  readsByGroup: {},

  setGroups: (groups) => set({ groups }),

  addGroup: (group) => set((state) => ({ groups: [...state.groups, group] })),

  updateGroup: (id, updates) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === id ? { ...g, ...updates } : g)),
    })),

  removeGroup: (id) =>
    set((state) => {
      const nextMessages = { ...state.messagesByGroup };
      delete nextMessages[id];
      const nextUnread = { ...state.unreadByGroup };
      delete nextUnread[id];
      const nextReads = { ...state.readsByGroup };
      delete nextReads[id];
      return {
        groups: state.groups.filter((g) => g.id !== id),
        activeGroupId: state.activeGroupId === id ? null : state.activeGroupId,
        messagesByGroup: nextMessages,
        unreadByGroup: nextUnread,
        readsByGroup: nextReads,
      };
    }),

  setActiveGroup: (id) => set({ activeGroupId: id }),

  setGroupMessagesAll: (messagesByGroup) => set({ messagesByGroup }),

  addGroupMessage: (groupId, message, incrementUnread = false) =>
    set((state) => {
      const existing = state.messagesByGroup[groupId] ?? [];
      if (existing.some((m) => m.id === message.id)) return state;

      const nextList = [...existing, message].slice(-MAX_MESSAGES_PER_GROUP);
      const nextUnread = incrementUnread
        ? {
            ...state.unreadByGroup,
            [groupId]: (state.unreadByGroup[groupId] ?? 0) + 1,
          }
        : state.unreadByGroup;

      return {
        messagesByGroup: { ...state.messagesByGroup, [groupId]: nextList },
        unreadByGroup: nextUnread,
      };
    }),

  updateGroupMessage: (groupId, messageId, updates) =>
    set((state) => {
      const existing = state.messagesByGroup[groupId];
      if (!existing) return state;

      let changed = false;
      const nextList = existing.map((m) => {
        if (m.id !== messageId) return m;
        changed = true;
        return { ...m, ...updates };
      });
      if (!changed) return state;

      return {
        messagesByGroup: { ...state.messagesByGroup, [groupId]: nextList },
      };
    }),

  deleteGroupMessage: (groupId, messageId) =>
    set((state) => {
      const existing = state.messagesByGroup[groupId];
      if (!existing) return state;

      const nextList = existing.filter((m) => m.id !== messageId);
      if (nextList.length === existing.length) return state;

      return {
        messagesByGroup: { ...state.messagesByGroup, [groupId]: nextList },
      };
    }),

  markGroupRead: (groupId) =>
    set((state) => {
      if (!state.unreadByGroup[groupId]) return state;
      return { unreadByGroup: { ...state.unreadByGroup, [groupId]: 0 } };
    }),

  recordGroupReads: (groupId, messageIds, readerId, recipientCount) =>
    set((state) => {
      const groupReads = state.readsByGroup[groupId] ?? {};
      const nextReads = { ...groupReads };
      const messages = state.messagesByGroup[groupId];
      const nextMessages = messages ? [...messages] : null;
      let messagesChanged = false;

      for (const messageId of messageIds) {
        const readers = nextReads[messageId] ?? [];
        if (!readers.includes(readerId)) {
          nextReads[messageId] = [...readers, readerId];
        }

        // Mark the message read once every recipient has acknowledged it.
        if (
          recipientCount > 0 &&
          (nextReads[messageId]?.length ?? 0) >= recipientCount &&
          nextMessages
        ) {
          const idx = nextMessages.findIndex((m) => m.id === messageId);
          const target = idx !== -1 ? nextMessages[idx] : undefined;
          if (target && target.status !== "read") {
            nextMessages[idx] = { ...target, status: "read" };
            messagesChanged = true;
          }
        }
      }

      return {
        readsByGroup: { ...state.readsByGroup, [groupId]: nextReads },
        ...(messagesChanged && nextMessages
          ? {
              messagesByGroup: {
                ...state.messagesByGroup,
                [groupId]: nextMessages,
              },
            }
          : {}),
      };
    }),
}));
