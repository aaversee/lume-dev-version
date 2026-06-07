import { z } from 'zod'

const PingMessageSchema = z.object({
  type: z.literal('ping'),
})

const TypingMessageSchema = z.object({
  type: z.literal('typing'),
  recipientId: z.string(),
  isTyping: z.boolean(),
  // Present when the typing event belongs to a group fan-out. The server only
  // relays it so the recipient can attribute typing to the group rather than a
  // 1:1 chat; the server never learns group membership.
  groupId: z.string().uuid().optional(),
})

const ReadReceiptMessageSchema = z.object({
  type: z.literal('read'),
  recipientId: z.string(),
  messageIds: z.array(z.string()),
  // Present when acknowledging messages read inside a group (relayed only).
  groupId: z.string().uuid().optional(),
})

export const WsMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  TypingMessageSchema,
  ReadReceiptMessageSchema,
])

export type WsMessage = z.infer<typeof WsMessageSchema>
export type TypingMessage = z.infer<typeof TypingMessageSchema>
export type ReadReceiptMessage = z.infer<typeof ReadReceiptMessageSchema>
