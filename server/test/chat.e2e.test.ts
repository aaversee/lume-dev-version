process.env.DB_PATH = ':memory:';
process.env.WS_JWT_SECRET = 'x'.repeat(40);

import request from 'supertest';
import express from 'express';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { describe, it, expect } from 'vitest';

import authRoutes from '../src/routes/auth';
import messageRoutes from '../src/routes/messages';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/messages', messageRoutes);
  app.use((_req, res) => res.sendStatus(404));
  return app;
}

function signHeaders(method: string, path: string, body: unknown, keyPair: nacl.SignKeyPair) {
  const timestamp = Date.now().toString();
  const nonce = `test-${crypto.randomUUID()}`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const bodyString = body && Object.keys(body as object).length > 0 ? JSON.stringify(body) : '';
  const msg = `${timestamp}.${nonce}.${method.toUpperCase()}.${normalizedPath}.${bodyString}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(msg), keyPair.secretKey);
  return {
    'X-Lume-Identity-Key': encodeBase64(keyPair.publicKey),
    'X-Lume-Signature': encodeBase64(sig),
    'X-Lume-Timestamp': timestamp,
    'X-Lume-Nonce': nonce,
    'X-Lume-Path': normalizedPath,
  };
}

function makeUser(prefix: string) {
  const username = `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const idKey = nacl.sign.keyPair();
  const spk = nacl.sign.keyPair();
  const signedPrekeySig = nacl.sign.detached(spk.publicKey, idKey.secretKey);
  return {
    username,
    idKey,
    idPublic: encodeBase64(idKey.publicKey),
    signedPrekey: encodeBase64(spk.publicKey),
    signedPrekeySignature: encodeBase64(signedPrekeySig),
  };
}

function makePayload() {
  return JSON.stringify({
    v: 1,
    alg: 'nacl-box',
    senderExchangeKey: encodeBase64(nacl.randomBytes(32)),
    ciphertext: encodeBase64(nacl.randomBytes(48)),
    nonce: encodeBase64(nacl.randomBytes(nacl.box.nonceLength)),
    timestamp: Date.now(),
  });
}

describe('E2E chat flow', () => {
  const app = buildApp();

  async function register(user: ReturnType<typeof makeUser>) {
    const res = await request(app).post('/api/auth/register').send({
      username: user.username,
      identityKey: user.idPublic,
      signedPrekey: user.signedPrekey,
      signedPrekeySignature: user.signedPrekeySignature,
      oneTimePrekeys: [],
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('send → pending → single ack: full round trip', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const aliceId = await register(alice);
    const bobId = await register(bob);

    // Alice sends a message to Bob
    const payload = makePayload();
    const sendBody = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: payload };
    const sendHeaders = signHeaders('POST', '/messages/send', sendBody, alice.idKey);
    const sendRes = await request(app).post('/api/messages/send').set(sendHeaders).send(sendBody);
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.messageId).toBeDefined();
    const messageId = sendRes.body.messageId;

    // Bob retrieves pending messages
    const pendingHeaders = signHeaders('GET', `/messages/pending/${bobId}`, {}, bob.idKey);
    const pendingRes = await request(app).get(`/api/messages/pending/${bobId}`).set(pendingHeaders);
    expect(pendingRes.status).toBe(200);
    const msgs = pendingRes.body.messages;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const found = msgs.find((m: { id: string }) => m.id === messageId);
    expect(found).toBeDefined();
    expect(found.senderId).toBe(aliceId);
    expect(found.senderUsername).toBe(alice.username);
    expect(found.encryptedPayload).toBe(payload);
    expect(found.timestamp).toBeGreaterThan(0);

    // Bob acknowledges the message
    const ackHeaders = signHeaders('DELETE', `/messages/${messageId}`, {}, bob.idKey);
    const ackRes = await request(app).delete(`/api/messages/${messageId}`).set(ackHeaders);
    expect(ackRes.status).toBe(200);

    // Verify message is gone from pending
    const pending2Headers = signHeaders('GET', `/messages/pending/${bobId}`, {}, bob.idKey);
    const pending2Res = await request(app).get(`/api/messages/pending/${bobId}`).set(pending2Headers);
    const remaining = pending2Res.body.messages.find((m: { id: string }) => m.id === messageId);
    expect(remaining).toBeUndefined();
  });

  it('batch acknowledge removes multiple messages', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const aliceId = await register(alice);
    const bobId = await register(bob);

    // Send two messages
    const body1 = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: makePayload() };
    const h1 = signHeaders('POST', '/messages/send', body1, alice.idKey);
    const r1 = await request(app).post('/api/messages/send').set(h1).send(body1);
    const body2 = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: makePayload() };
    const h2 = signHeaders('POST', '/messages/send', body2, alice.idKey);
    const r2 = await request(app).post('/api/messages/send').set(h2).send(body2);

    // Batch ack
    const ackBody = { messageIds: [r1.body.messageId, r2.body.messageId] };
    const ackHeaders = signHeaders('POST', '/messages/acknowledge', ackBody, bob.idKey);
    const ackRes = await request(app).post('/api/messages/acknowledge').set(ackHeaders).send(ackBody);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acknowledged).toBe(2);

    // Verify empty
    const pH = signHeaders('GET', `/messages/pending/${bobId}`, {}, bob.idKey);
    const pRes = await request(app).get(`/api/messages/pending/${bobId}`).set(pH);
    expect(pRes.body.messages.length).toBe(0);
  });

  it('blocked sender message is silently accepted but not stored', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const aliceId = await register(alice);
    const bobId = await register(bob);

    // Bob blocks Alice
    const blockBody = { blockedId: aliceId };
    const blockH = signHeaders('POST', '/auth/block', blockBody, bob.idKey);
    await request(app).post('/api/auth/block').set(blockH).send(blockBody);

    // Alice sends — silently accepted
    const sendBody = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: makePayload() };
    const sendH = signHeaders('POST', '/messages/send', sendBody, alice.idKey);
    const sendRes = await request(app).post('/api/messages/send').set(sendH).send(sendBody);
    expect(sendRes.status).toBe(201);

    // Bob has no pending from Alice
    const pH = signHeaders('GET', `/messages/pending/${bobId}`, {}, bob.idKey);
    const pRes = await request(app).get(`/api/messages/pending/${bobId}`).set(pH);
    expect(pRes.body.messages.length).toBe(0);
  });

  // === Error cases ===

  it('send to non-existent recipient returns 404', async () => {
    const alice = makeUser('alice');
    const aliceId = await register(alice);

    const body = { senderId: aliceId, recipientUsername: 'ghost_user', encryptedPayload: makePayload() };
    const h = signHeaders('POST', '/messages/send', body, alice.idKey);
    const res = await request(app).post('/api/messages/send').set(h).send(body);
    expect(res.status).toBe(404);
  });

  it('empty encrypted payload returns 400', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const aliceId = await register(alice);
    await register(bob);

    const body = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: '' };
    const h = signHeaders('POST', '/messages/send', body, alice.idKey);
    const res = await request(app).post('/api/messages/send').set(h).send(body);
    expect(res.status).toBe(400);
  });

  it('invalid senderId format returns 400', async () => {
    const alice = makeUser('alice');
    await register(alice);

    const body = { senderId: 'bad-id', recipientUsername: 'someone', encryptedPayload: makePayload() };
    const h = signHeaders('POST', '/messages/send', body, alice.idKey);
    const res = await request(app).post('/api/messages/send').set(h).send(body);
    expect(res.status).toBe(400);
  });

  it('non-existent senderId returns 401', async () => {
    const alice = makeUser('alice');
    await register(alice);

    const fakeId = '00000000-0000-4000-8000-000000000099';
    const body = { senderId: fakeId, recipientUsername: 'someone', encryptedPayload: makePayload() };
    const h = signHeaders('POST', '/messages/send', body, alice.idKey);
    const res = await request(app).post('/api/messages/send').set(h).send(body);
    expect(res.status).toBe(401);
  });

  it('identity key mismatch returns 403', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const aliceId = await register(alice);
    await register(bob);

    // Bob signs request with Alice's senderId
    const body = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: makePayload() };
    const h = signHeaders('POST', '/messages/send', body, bob.idKey);
    const res = await request(app).post('/api/messages/send').set(h).send(body);
    expect(res.status).toBe(403);
  });

  it('acknowledge non-existent message returns 404', async () => {
    const bob = makeUser('bob');
    await register(bob);

    const fakeId = '00000000-0000-4000-8000-000000000077';
    const h = signHeaders('DELETE', `/messages/${fakeId}`, {}, bob.idKey);
    const res = await request(app).delete(`/api/messages/${fakeId}`).set(h);
    expect(res.status).toBe(404);
  });

  it("acknowledge another user's message returns 403", async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const eve = makeUser('eve');
    const aliceId = await register(alice);
    await register(bob);
    await register(eve);

    const body = { senderId: aliceId, recipientUsername: bob.username, encryptedPayload: makePayload() };
    const sH = signHeaders('POST', '/messages/send', body, alice.idKey);
    const sRes = await request(app).post('/api/messages/send').set(sH).send(body);
    const msgId = sRes.body.messageId;

    // Eve tries to ack Bob's message
    const eH = signHeaders('DELETE', `/messages/${msgId}`, {}, eve.idKey);
    const res = await request(app).delete(`/api/messages/${msgId}`).set(eH);
    expect(res.status).toBe(403);
  });

  it("fetch another user's pending messages returns 403", async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    await register(alice);
    const bobId = await register(bob);

    const h = signHeaders('GET', `/messages/pending/${bobId}`, {}, alice.idKey);
    const res = await request(app).get(`/api/messages/pending/${bobId}`).set(h);
    expect(res.status).toBe(403);
  });

  it('missing auth headers returns 401', async () => {
    const res = await request(app).post('/api/messages/send').send({
      senderId: 'x', recipientUsername: 'y', encryptedPayload: 'z',
    });
    expect(res.status).toBe(401);
  });
});
