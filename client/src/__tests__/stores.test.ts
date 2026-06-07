/**
 * Tests for stores/index.ts
 * Covers: useAuthStore, useContactsStore, useChatsStore, useUIStore,
 * useBlockedStore, useTypingStore, useSessionsStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAuthStore,
  useContactsStore,
  useChatsStore,
  useUIStore,
  useBlockedStore,
  useTypingStore,
  useSessionsStore,
  type Chat,
  type Message,
} from '@/stores';
import { useGroupsStore } from '@/stores/groups';
import { generateIdentityKeys, generateExchangeKeyPair } from '@/crypto/keys';
import type { Contact } from '@/crypto/storage';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeContact(id: string): Contact {
  return {
    id,
    username: `user_${id}`,
    publicKey: `pub_${id}`,
    exchangeKey: `exch_${id}`,
    addedAt: Date.now(),
  };
}

function makeMessage(id: string, chatId: string, opts?: Partial<Message>): Message {
  return {
    id,
    chatId,
    senderId: 'me',
    content: `msg_${id}`,
    type: 'text',
    timestamp: Date.now(),
    status: 'sent',
    ...opts,
  };
}

function makeChat(id: string, contactId: string, messages: Message[] = []): Chat {
  return {
    id,
    contactId,
    messages,
    unreadCount: 0,
    isHidden: false,
  };
}

// ── useAuthStore ─────────────────────────────────────────────────────────────

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('initial state is unauthenticated', () => {
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userId).toBeNull();
    expect(state.username).toBeNull();
    expect(state.hasIdentityKeys).toBe(false);
  });

  it('setAuth sets public fields', () => {
    useAuthStore.getState().setAuth('user1', 'alice');

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.userId).toBe('user1');
    expect(state.username).toBe('alice');
    expect(state.hasIdentityKeys).toBe(true);
  });

  it('clearAuth resets everything', () => {
    useAuthStore.getState().setAuth('user1', 'alice');
    useAuthStore.getState().clearAuth();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userId).toBeNull();
    expect(state.username).toBeNull();
    expect(state.hasIdentityKeys).toBe(false);
  });
});

// ── useContactsStore ─────────────────────────────────────────────────────────

describe('useContactsStore', () => {
  beforeEach(() => {
    useContactsStore.getState().setContacts([]);
  });

  it('initial state has empty contacts', () => {
    expect(useContactsStore.getState().contacts).toEqual([]);
  });

  it('setContacts replaces all contacts', () => {
    const contacts = [makeContact('a'), makeContact('b')];
    useContactsStore.getState().setContacts(contacts);
    expect(useContactsStore.getState().contacts).toEqual(contacts);
  });

  it('addContact appends a contact', () => {
    useContactsStore.getState().setContacts([makeContact('a')]);
    useContactsStore.getState().addContact(makeContact('b'));

    const contacts = useContactsStore.getState().contacts;
    expect(contacts.length).toBe(2);
    expect(contacts[1]!.id).toBe('b');
  });

  it('removeContact removes by id', () => {
    useContactsStore.getState().setContacts([makeContact('a'), makeContact('b')]);
    useContactsStore.getState().removeContact('a');

    const contacts = useContactsStore.getState().contacts;
    expect(contacts.length).toBe(1);
    expect(contacts[0]!.id).toBe('b');
  });

  it('removeContact with non-existent id does nothing', () => {
    useContactsStore.getState().setContacts([makeContact('a')]);
    useContactsStore.getState().removeContact('nonexistent');
    expect(useContactsStore.getState().contacts.length).toBe(1);
  });

  it('updateContact merges partial updates', () => {
    useContactsStore.getState().setContacts([makeContact('a')]);
    useContactsStore.getState().updateContact('a', { displayName: 'Alice', verified: true });

    const contact = useContactsStore.getState().contacts[0]!;
    expect(contact.displayName).toBe('Alice');
    expect(contact.verified).toBe(true);
    expect(contact.username).toBe('user_a'); // unchanged
  });
});

// ── useChatsStore ────────────────────────────────────────────────────────────

describe('useChatsStore', () => {
  beforeEach(() => {
    useChatsStore.getState().setChats([]);
    useChatsStore.getState().setActiveChat(null);
  });

  it('initial state has empty chats', () => {
    const state = useChatsStore.getState();
    expect(state.chats).toEqual([]);
    expect(state.activeChatId).toBeNull();
  });

  it('addChat appends a chat', () => {
    useChatsStore.getState().addChat(makeChat('c1', 'contact1'));
    expect(useChatsStore.getState().chats.length).toBe(1);
    expect(useChatsStore.getState().chats[0]!.id).toBe('c1');
  });

  it('addMessage appends message to correct chat', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1')]);
    const msg = makeMessage('m1', 'c1');

    useChatsStore.getState().addMessage('c1', msg);

    const chat = useChatsStore.getState().chats[0]!;
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0]!.id).toBe('m1');
    expect(chat.lastMessage).toEqual(msg);
  });

  it('addMessage deduplicates by message id', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1')]);
    const msg = makeMessage('m1', 'c1');

    useChatsStore.getState().addMessage('c1', msg);
    useChatsStore.getState().addMessage('c1', msg); // duplicate

    const chat = useChatsStore.getState().chats[0]!;
    expect(chat.messages.length).toBe(1);
  });

  it('addMessage respects MAX_MESSAGES_PER_CHAT cap (200)', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 199; i++) {
      messages.push(makeMessage(`existing_${i}`, 'c1'));
    }
    useChatsStore.getState().setChats([{
      ...makeChat('c1', 'contact1'),
      messages,
    }]);

    // Add 5 more messages to exceed 200
    for (let i = 0; i < 5; i++) {
      useChatsStore.getState().addMessage('c1', makeMessage(`new_${i}`, 'c1'));
    }

    const chat = useChatsStore.getState().chats[0]!;
    expect(chat.messages.length).toBeLessThanOrEqual(200);
    // Latest messages should be kept
    expect(chat.messages[chat.messages.length - 1]!.id).toBe('new_4');
  });

  it('addMessage increments unreadCount when chat is NOT active', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1')]);
    useChatsStore.getState().setActiveChat(null); // not active

    useChatsStore.getState().addMessage('c1', makeMessage('m1', 'c1'));

    expect(useChatsStore.getState().chats[0]!.unreadCount).toBe(1);
  });

  it('addMessage does NOT increment unreadCount when chat IS active', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1')]);
    useChatsStore.getState().setActiveChat('c1');

    useChatsStore.getState().addMessage('c1', makeMessage('m1', 'c1'));

    expect(useChatsStore.getState().chats[0]!.unreadCount).toBe(0);
  });

  it('deleteMessage removes message and updates lastMessage', () => {
    const msg1 = makeMessage('m1', 'c1', { timestamp: 1000 });
    const msg2 = makeMessage('m2', 'c1', { timestamp: 2000 });

    useChatsStore.getState().setChats([{
      ...makeChat('c1', 'contact1'),
      messages: [msg1, msg2],
      lastMessage: msg2,
    }]);

    useChatsStore.getState().deleteMessage('c1', 'm2');

    const chat = useChatsStore.getState().chats[0]!;
    expect(chat.messages.length).toBe(1);
    expect(chat.lastMessage).toEqual(msg1);
  });

  it('deleteChat removes the chat and resets activeChatId if active', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1'), makeChat('c2', 'contact2')]);
    useChatsStore.getState().setActiveChat('c1');

    useChatsStore.getState().deleteChat('c1');

    const state = useChatsStore.getState();
    expect(state.chats.length).toBe(1);
    expect(state.chats[0]!.id).toBe('c2');
    expect(state.activeChatId).toBeNull();
  });

  it('markAsRead resets unreadCount to 0', () => {
    useChatsStore.getState().setChats([{
      ...makeChat('c1', 'contact1'),
      unreadCount: 5,
    }]);

    useChatsStore.getState().markAsRead('c1');
    expect(useChatsStore.getState().chats[0]!.unreadCount).toBe(0);
  });

  it('setChatHidden toggles isHidden', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1')]);

    useChatsStore.getState().setChatHidden('c1', true);
    expect(useChatsStore.getState().chats[0]!.isHidden).toBe(true);

    useChatsStore.getState().setChatHidden('c1', false);
    expect(useChatsStore.getState().chats[0]!.isHidden).toBe(false);
  });

  it('setSelfDestructTimer sets timer value', () => {
    useChatsStore.getState().setChats([makeChat('c1', 'contact1')]);

    useChatsStore.getState().setSelfDestructTimer('c1', 60);
    expect(useChatsStore.getState().chats[0]!.selfDestructTimer).toBe(60);

    useChatsStore.getState().setSelfDestructTimer('c1', undefined);
    expect(useChatsStore.getState().chats[0]!.selfDestructTimer).toBeUndefined();
  });

  it('updateMessage updates specific message fields', () => {
    const msg = makeMessage('m1', 'c1', { status: 'sending' });
    useChatsStore.getState().setChats([{
      ...makeChat('c1', 'contact1'),
      messages: [msg],
      lastMessage: msg,
    }]);

    useChatsStore.getState().updateMessage('c1', 'm1', { status: 'delivered' });

    const chat = useChatsStore.getState().chats[0]!;
    expect(chat.messages[0]!.status).toBe('delivered');
    expect(chat.lastMessage!.status).toBe('delivered');
  });

  it('pruneExpiredMessages removes self-destructed messages', () => {
    const now = 10000;
    const expired = makeMessage('m1', 'c1', { selfDestructAt: 5000 });
    const valid = makeMessage('m2', 'c1', { selfDestructAt: 20000 });
    const noTimer = makeMessage('m3', 'c1');

    useChatsStore.getState().setChats([{
      ...makeChat('c1', 'contact1'),
      messages: [expired, valid, noTimer],
      unreadCount: 3,
    }]);

    useChatsStore.getState().pruneExpiredMessages(now);

    const chat = useChatsStore.getState().chats[0]!;
    expect(chat.messages.length).toBe(2);
    expect(chat.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(chat.unreadCount).toBeLessThanOrEqual(2);
  });
});

// ── useUIStore ───────────────────────────────────────────────────────────────

describe('useUIStore', () => {
  beforeEach(() => {
    // Reset to defaults
    useUIStore.setState({
      isPanicMode: false,
      showHiddenChats: false,
      isOnline: true,
      wsConnected: false,
      wsStatus: 'disconnected',
      cryptoBanner: null,
    });
  });

  it('setPanicMode toggles isPanicMode', () => {
    useUIStore.getState().setPanicMode(true);
    expect(useUIStore.getState().isPanicMode).toBe(true);

    useUIStore.getState().setPanicMode(false);
    expect(useUIStore.getState().isPanicMode).toBe(false);
  });

  it('setShowHiddenChats toggles showHiddenChats', () => {
    useUIStore.getState().setShowHiddenChats(true);
    expect(useUIStore.getState().showHiddenChats).toBe(true);
  });

  it('setOnline updates isOnline', () => {
    useUIStore.getState().setOnline(false);
    expect(useUIStore.getState().isOnline).toBe(false);
  });

  it('setWsConnected updates wsConnected and wsStatus', () => {
    useUIStore.getState().setWsConnected(true);
    const state = useUIStore.getState();
    expect(state.wsConnected).toBe(true);
    expect(state.wsStatus).toBe('connected');

    useUIStore.getState().setWsConnected(false);
    const state2 = useUIStore.getState();
    expect(state2.wsConnected).toBe(false);
    expect(state2.wsStatus).toBe('disconnected');
  });

  it('setWsStatus updates both wsStatus and wsConnected', () => {
    useUIStore.getState().setWsStatus('rate_limited');
    const state = useUIStore.getState();
    expect(state.wsStatus).toBe('rate_limited');
    expect(state.wsConnected).toBe(false);

    useUIStore.getState().setWsStatus('connected');
    expect(useUIStore.getState().wsConnected).toBe(true);
  });

  it('setCryptoBanner / clearCryptoBanner', () => {
    useUIStore.getState().setCryptoBanner({ level: 'error', message: 'Key mismatch' });

    const banner = useUIStore.getState().cryptoBanner;
    expect(banner).not.toBeNull();
    expect(banner!.level).toBe('error');
    expect(banner!.message).toBe('Key mismatch');
    expect(banner!.updatedAt).toBeGreaterThan(0);

    useUIStore.getState().clearCryptoBanner();
    expect(useUIStore.getState().cryptoBanner).toBeNull();
  });

  it('setCryptoBanner deduplicates rapid identical updates', () => {
    useUIStore.getState().setCryptoBanner({ level: 'warning', message: 'Same warning' });
    const firstUpdatedAt = useUIStore.getState().cryptoBanner!.updatedAt;

    // Immediately set same message — should be deduplicated
    useUIStore.getState().setCryptoBanner({ level: 'warning', message: 'Same warning' });
    const secondUpdatedAt = useUIStore.getState().cryptoBanner!.updatedAt;

    expect(secondUpdatedAt).toBe(firstUpdatedAt);
  });
});

// ── useBlockedStore ──────────────────────────────────────────────────────────

describe('useBlockedStore', () => {
  beforeEach(() => {
    useBlockedStore.getState().setBlockedIds([]);
  });

  it('initial state has no blocked ids', () => {
    expect(useBlockedStore.getState().blockedIds).toEqual({});
  });

  it('setBlockedIds sets from array', () => {
    useBlockedStore.getState().setBlockedIds(['a', 'b']);
    const blocked = useBlockedStore.getState().blockedIds;
    expect(blocked['a']).toBe(true);
    expect(blocked['b']).toBe(true);
  });

  it('addBlocked adds a single id', () => {
    useBlockedStore.getState().addBlocked('x');
    expect(useBlockedStore.getState().blockedIds['x']).toBe(true);
  });

  it('addBlocked is idempotent', () => {
    useBlockedStore.getState().addBlocked('x');
    useBlockedStore.getState().addBlocked('x');
    expect(Object.keys(useBlockedStore.getState().blockedIds).length).toBe(1);
  });

  it('removeBlocked removes a single id', () => {
    useBlockedStore.getState().setBlockedIds(['a', 'b']);
    useBlockedStore.getState().removeBlocked('a');

    const blocked = useBlockedStore.getState().blockedIds;
    expect(blocked['a']).toBeUndefined();
    expect(blocked['b']).toBe(true);
  });

  it('removeBlocked on non-existent id is a no-op', () => {
    useBlockedStore.getState().setBlockedIds(['a']);
    const before = useBlockedStore.getState().blockedIds;
    useBlockedStore.getState().removeBlocked('nonexistent');
    const after = useBlockedStore.getState().blockedIds;
    // Should be same reference (no state update)
    expect(before).toBe(after);
  });

  it('isBlocked returns correct boolean', () => {
    useBlockedStore.getState().setBlockedIds(['a']);
    expect(useBlockedStore.getState().isBlocked('a')).toBe(true);
    expect(useBlockedStore.getState().isBlocked('b')).toBe(false);
  });
});

// ── useTypingStore ───────────────────────────────────────────────────────────

describe('useTypingStore', () => {
  beforeEach(() => {
    useTypingStore.getState().clearAll();
  });

  it('setTyping true marks user as typing', () => {
    useTypingStore.getState().setTyping('contact1', true);
    expect(useTypingStore.getState().typingUsers['contact1']).toBe(true);
  });

  it('setTyping false removes typing indicator', () => {
    useTypingStore.getState().setTyping('contact1', true);
    useTypingStore.getState().setTyping('contact1', false);
    expect(useTypingStore.getState().typingUsers['contact1']).toBeUndefined();
  });

  it('clearAll removes all typing indicators', () => {
    useTypingStore.getState().setTyping('a', true);
    useTypingStore.getState().setTyping('b', true);
    useTypingStore.getState().clearAll();
    expect(useTypingStore.getState().typingUsers).toEqual({});
  });

  it('setGroupTyping tracks members per group', () => {
    useTypingStore.getState().setGroupTyping('g1', 'u1', true);
    expect(useTypingStore.getState().groupTypingUsers['g1']?.['u1']).toBe(true);
  });

  it('setGroupTyping false removes the member', () => {
    useTypingStore.getState().setGroupTyping('g1', 'u1', true);
    useTypingStore.getState().setGroupTyping('g1', 'u1', false);
    expect(
      useTypingStore.getState().groupTypingUsers['g1']?.['u1'],
    ).toBeUndefined();
  });

  it('clearAll also clears group typing', () => {
    useTypingStore.getState().setGroupTyping('g1', 'u1', true);
    useTypingStore.getState().clearAll();
    expect(useTypingStore.getState().groupTypingUsers).toEqual({});
  });
});

// ── useSessionsStore ─────────────────────────────────────────────────────────

describe('useSessionsStore', () => {
  beforeEach(() => {
    useSessionsStore.getState().setSessions({});
  });

  it('upsertSession adds a contact ID to sessionContactIds', () => {
    const session = {
      dhSendingKeyPair: generateExchangeKeyPair(),
      dhReceivingPublicKey: null,
      rootKey: 'rk',
      sendingChainKey: null,
      receivingChainKey: null,
      sendingMessageNumber: 0,
      receivingMessageNumber: 0,
      previousSendingChainLength: 0,
      skippedMessageKeys: [] as [string, string][],
    };

    useSessionsStore.getState().upsertSession('contact1', session);
    expect(useSessionsStore.getState().sessionContactIds).toContain('contact1');
  });

  it('deleteSession removes contact ID from sessionContactIds', () => {
    const session = {
      dhSendingKeyPair: generateExchangeKeyPair(),
      dhReceivingPublicKey: null,
      rootKey: 'rk',
      sendingChainKey: null,
      receivingChainKey: null,
      sendingMessageNumber: 0,
      receivingMessageNumber: 0,
      previousSendingChainLength: 0,
      skippedMessageKeys: [] as [string, string][],
    };

    useSessionsStore.getState().upsertSession('contact1', session);
    useSessionsStore.getState().deleteSession('contact1');
    expect(useSessionsStore.getState().sessionContactIds).not.toContain('contact1');
  });

  it('deleteSession on non-existent id is a no-op', () => {
    const before = useSessionsStore.getState().sessionContactIds;
    useSessionsStore.getState().deleteSession('nonexistent');
    expect(useSessionsStore.getState().sessionContactIds).toEqual(before);
  });
});

// ── useGroupsStore — recordGroupReads ────────────────────────────────────────

describe('useGroupsStore — recordGroupReads', () => {
  beforeEach(() => {
    useGroupsStore.setState({
      groups: [],
      activeGroupId: null,
      messagesByGroup: {},
      unreadByGroup: {},
      readsByGroup: {},
    });
  });

  it('marks an outgoing message read only after all recipients ack', () => {
    useGroupsStore
      .getState()
      .addGroupMessage('g1', makeMessage('m1', 'g1', { status: 'sent' }));

    useGroupsStore.getState().recordGroupReads('g1', ['m1'], 'r1', 2);
    expect(useGroupsStore.getState().messagesByGroup['g1']?.[0]?.status).toBe(
      'sent',
    );

    useGroupsStore.getState().recordGroupReads('g1', ['m1'], 'r2', 2);
    expect(useGroupsStore.getState().messagesByGroup['g1']?.[0]?.status).toBe(
      'read',
    );
  });

  it('dedupes the same reader and does not over-count', () => {
    useGroupsStore
      .getState()
      .addGroupMessage('g1', makeMessage('m1', 'g1', { status: 'sent' }));

    useGroupsStore.getState().recordGroupReads('g1', ['m1'], 'r1', 2);
    useGroupsStore.getState().recordGroupReads('g1', ['m1'], 'r1', 2);

    expect(useGroupsStore.getState().readsByGroup['g1']?.['m1']).toEqual(['r1']);
    expect(useGroupsStore.getState().messagesByGroup['g1']?.[0]?.status).toBe(
      'sent',
    );
  });
});
