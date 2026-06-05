/**
 * Regression tests for lib/groupMessaging.ts
 * Focus: session persistence behavior around failed first-send handshakes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBundle: vi.fn(),
  send: vi.fn(),
  vaultGetSession: vi.fn(),
  vaultGetExchangeKeyPair: vi.fn(() => ({
    publicKey: 'sender-exchange-pk',
    secretKey: new Uint8Array(32),
  })),
  vaultGetPublicKeys: vi.fn(() => ({
    exchangePublicKey: 'sender-exchange-pk',
    signingPublicKey: 'sender-signing-pk',
  })),
  deserializeSession: vi.fn(),
  initSenderSession: vi.fn(),
  ratchetEncrypt: vi.fn(),
  serializeSession: vi.fn(),
  x3dhInitiate: vi.fn(),
  verify: vi.fn(),
  decodeBase64: vi.fn(),
  encodeRatchetEnvelope: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  authApi: {
    getBundle: mocks.getBundle,
  },
  messagesApi: {
    send: mocks.send,
  },
}));

vi.mock('@/crypto/keyVault', () => ({
  vaultGetSession: mocks.vaultGetSession,
  vaultGetExchangeKeyPair: mocks.vaultGetExchangeKeyPair,
  vaultGetPublicKeys: mocks.vaultGetPublicKeys,
}));

vi.mock('@/crypto/ratchet', () => ({
  deserializeSession: mocks.deserializeSession,
  initSenderSession: mocks.initSenderSession,
  ratchetEncrypt: mocks.ratchetEncrypt,
  serializeSession: mocks.serializeSession,
  x3dhInitiate: mocks.x3dhInitiate,
}));

vi.mock('@/crypto/keys', () => ({
  verify: mocks.verify,
}));

vi.mock('tweetnacl-util', () => ({
  decodeBase64: mocks.decodeBase64,
}));

vi.mock('@/stores', () => ({
  useSessionsStore: {
    getState: () => ({
      upsertSession: mocks.upsertSession,
    }),
  },
}));

vi.mock('@/lib/ratchetPayload', () => ({
  encodeRatchetEnvelope: mocks.encodeRatchetEnvelope,
}));

import type { GroupData } from '@/lib/api';
import { sendGroupMessage } from '@/lib/groupMessaging';

const groupFixture: GroupData = {
  id: 'group-1',
  name: 'Core Team',
  creator_id: 'alice',
  created_at: Date.now(),
  members: [
    { user_id: 'alice', username: 'alice', role: 'admin' },
    { user_id: 'bob', username: 'bob', role: 'member' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.vaultGetSession.mockReturnValue(undefined);
  mocks.getBundle.mockResolvedValue({
    data: {
      id: 'bob',
      username: 'bob',
      identityKey: 'bundle-identity',
      exchangeKey: 'bundle-exchange',
      signedPrekey: 'bundle-spk',
      signedPrekeySignature: 'bundle-spk-sig',
      oneTimePrekey: 'bundle-opk',
      exchangeIdentityKey: 'bundle-exchange-identity',
    },
  });
  mocks.send.mockResolvedValue({ data: { messageId: 'm-1', delivered: true } });
  mocks.verify.mockReturnValue(true);
  mocks.decodeBase64.mockReturnValue(new Uint8Array([1, 2, 3]));
  mocks.x3dhInitiate.mockReturnValue({
    sharedSecret: new Uint8Array([9, 9, 9]),
    ephemeralPublicKey: 'ephemeral-pk',
  });
  mocks.initSenderSession.mockReturnValue({ ratchet: 'new-session' });
  mocks.deserializeSession.mockReturnValue({ ratchet: 'existing-session' });
  mocks.ratchetEncrypt.mockReturnValue({
    header: { dhPublicKey: 'dh', previousChainLength: 0, messageNumber: 0 },
    ciphertext: 'ciphertext',
    nonce: 'nonce',
  });
  mocks.encodeRatchetEnvelope.mockReturnValue('encoded-payload');
  mocks.serializeSession.mockReturnValue({ serialized: 'session' });
});

describe('sendGroupMessage', () => {
  it('does not persist a fresh session when initial send is rejected', async () => {
    mocks.send.mockResolvedValue({ error: 'Request failed: 500' });

    const result = await sendGroupMessage({
      group: groupFixture,
      senderId: 'alice',
      content: 'hello',
      timestamp: 123,
    });

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });

  it('persists session state when send succeeds', async () => {
    const result = await sendGroupMessage({
      group: groupFixture,
      senderId: 'alice',
      content: 'hello',
      timestamp: 123,
    });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(mocks.upsertSession).toHaveBeenCalledOnce();
    expect(mocks.upsertSession).toHaveBeenCalledWith('bob', {
      serialized: 'session',
    });
  });

  it('keeps advancing an already-established session on failed resend', async () => {
    mocks.vaultGetSession.mockReturnValue('serialized-existing');
    mocks.send.mockResolvedValue({ error: 'Network error' });

    const result = await sendGroupMessage({
      group: groupFixture,
      senderId: 'alice',
      content: 'hello',
      timestamp: 123,
    });

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(mocks.deserializeSession).toHaveBeenCalledWith('serialized-existing');
    expect(mocks.getBundle).not.toHaveBeenCalled();
    expect(mocks.upsertSession).toHaveBeenCalledOnce();
    expect(mocks.upsertSession).toHaveBeenCalledWith('bob', {
      serialized: 'session',
    });
  });
});
