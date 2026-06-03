/**
 * Group messaging via pairwise fan-out.
 *
 * A group message is encrypted separately for each member using the existing 1:1
 * Double Ratchet session (establishing one via X3DH on first contact), then sent
 * as N individual messages over the normal /messages/send route. The group is
 * identified by `groupId` carried INSIDE the encrypted plaintext, so the server
 * still only relays opaque per-recipient ciphertext and never learns group
 * membership or that a message is part of a group.
 */

import { authApi, messagesApi } from "@/lib/api";
import type { GroupData } from "@/lib/api";
import { encodeRatchetEnvelope, type X3DHInitPayload } from "@/lib/ratchetPayload";
import {
  deserializeSession,
  initSenderSession,
  ratchetEncrypt,
  serializeSession,
  x3dhInitiate,
} from "@/crypto/ratchet";
import {
  vaultGetSession,
  vaultGetExchangeKeyPair,
  vaultGetPublicKeys,
} from "@/crypto/keyVault";
import { verify } from "@/crypto/keys";
import { decodeBase64 } from "tweetnacl-util";
import { useSessionsStore, type MessageReplyRef } from "@/stores";

export interface GroupSendResult {
  sent: number;
  failed: number;
}

export async function sendGroupMessage(params: {
  group: GroupData;
  senderId: string;
  content: string;
  timestamp: number;
  replyTo?: MessageReplyRef;
}): Promise<GroupSendResult> {
  const { group, senderId, content, timestamp, replyTo } = params;

  const recipients = group.members.filter((m) => m.user_id !== senderId);

  const plaintext = JSON.stringify({
    content,
    timestamp,
    groupId: group.id,
    ...(replyTo ? { replyTo } : {}),
  });
  const plaintextBytes = new TextEncoder().encode(plaintext);

  let sent = 0;
  let failed = 0;

  for (const member of recipients) {
    try {
      const existing = vaultGetSession(member.user_id);
      let session = existing ? deserializeSession(existing) : null;
      let x3dhInit: X3DHInitPayload | undefined;

      if (!session) {
        // First message to this member: X3DH (bundle signature verified) then ratchet.
        const { data: bundle, error: bundleError } = await authApi.getBundle(
          member.username,
        );
        if (bundleError || !bundle) {
          throw new Error(bundleError || "Failed to fetch bundle");
        }

        const ok = verify(
          decodeBase64(bundle.signedPrekey),
          decodeBase64(bundle.signedPrekeySignature),
          bundle.identityKey,
        );
        if (!ok) throw new Error("Invalid signed prekey signature");

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
        ...(x3dhInit ? { x3dh: x3dhInit } : {}),
      });

      useSessionsStore
        .getState()
        .upsertSession(member.user_id, serializeSession(session));

      const { error: sendError } = await messagesApi.send({
        senderId,
        recipientUsername: member.username,
        encryptedPayload,
      });

      if (sendError) {
        failed++;
      } else {
        sent++;
      }
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}
