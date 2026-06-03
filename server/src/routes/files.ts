import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import rateLimit from 'express-rate-limit'
import fs from 'fs'
import path from 'path'

import database from '../db/database'
import { requireSignature } from '../middleware/auth'
import { validateBody, validateParams } from '../middleware/validate'
import { UploadFileBodySchema, FileIdParamSchema } from '../schemas/files'

const router = Router()

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads')
)

/** Strict UUID pattern — only hex and hyphens, no path separators possible. */
const SAFE_FILENAME_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/**
 * Safely resolve a file path within UPLOAD_DIR.
 * Returns null if the filename fails the strict UUID regex (blocks path traversal).
 */
function safeFilePath(fileId: string): string | null {
  if (!SAFE_FILENAME_RE.test(fileId)) return null
  return path.join(UPLOAD_DIR, fileId)
}

/**
 * Delete encrypted file blobs from disk by id. Best-effort: missing files (ENOENT) are ignored.
 * Used by the periodic expired-file cleanup so disk does not accumulate orphaned blobs.
 */
export async function deleteFileBlobs(fileIds: string[]): Promise<void> {
  await Promise.all(
    fileIds.map(async fileId => {
      const filePath = safeFilePath(fileId)
      if (!filePath) return
      try {
        await fs.promises.unlink(filePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to delete file blob:', fileId)
        }
      }
    })
  )
}

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const MAX_FILES_PER_USER = 500
const FILE_EXPIRY_DAYS = 30

// Ensure upload directory exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const uploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    if (req.user?.userId) return `upload:${req.user.userId}`
    const identityKey = req.user?.identityKey
    if (identityKey) {
      const user = database.getUserByIdentityKey(identityKey)
      if (user) return `upload:${user.id}`
    }
    return `upload:ip:${req.ip || '127.0.0.1'}`
  },
})

const downloadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    if (req.user?.userId) return `download:${req.user.userId}`
    const identityKey = req.user?.identityKey
    if (identityKey) {
      const user = database.getUserByIdentityKey(identityKey)
      if (user) return `download:${user.id}`
    }
    return `download:ip:${req.ip || '127.0.0.1'}`
  },
})

// POST /files/upload — upload an encrypted file blob
router.post(
  '/upload',
  requireSignature,
  uploadRateLimit,
  validateBody(UploadFileBodySchema),
  async (req: Request, res: Response) => {
    try {
      const signerId = req.user?.userId
      if (!signerId) {
        res.status(403).json({ error: 'Unauthorized' })
        return
      }

      // Check file count limit
      if (database.getUserFileCount(signerId) >= MAX_FILES_PER_USER) {
        res.status(429).json({ error: 'File storage limit reached' })
        return
      }

      const { data, mimeHint, recipientId } = req.body as {
        data: string
        mimeHint?: string
        recipientId?: string
      }

      // data is base64-encoded encrypted blob
      const buffer = Buffer.from(data, 'base64')
      if (buffer.length === 0 || buffer.length > MAX_FILE_SIZE) {
        res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` })
        return
      }

      const safeMime = mimeHint ?? 'application/octet-stream'

      const fileId = uuidv4()
      const expiresAt = Math.floor(Date.now() / 1000) + FILE_EXPIRY_DAYS * 24 * 60 * 60

      // Write encrypted blob to disk
      const filePath = safeFilePath(fileId)
      if (!filePath) {
        res.status(400).json({ error: 'Invalid file ID' })
        return
      }
      await fs.promises.writeFile(filePath, buffer)

      database.createFile(fileId, signerId, buffer.length, safeMime, expiresAt, recipientId)

      res.status(201).json({
        fileId,
        size: buffer.length,
        expiresAt: expiresAt * 1000,
      })
    } catch (error) {
      console.error('File upload error:', error instanceof Error ? error.message : String(error))
      res.status(500).json({ error: 'Failed to upload file' })
    }
  }
)

// GET /files/:fileId/raw — stream encrypted file blob as binary (preferred)
router.get(
  '/:fileId/raw',
  requireSignature,
  downloadRateLimit,
  validateParams(FileIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const fileId = req.params.fileId!

      if (!req.user?.userId) {
        res.status(403).json({ error: 'Unauthorized' })
        return
      }

      const file = database.getFileById(fileId)
      if (!file) {
        res.status(404).json({ error: 'File not found' })
        return
      }

      // Access control: if recipient_id is set, only uploader or recipient may download
      if (
        file.recipient_id &&
        req.user.userId !== file.uploader_id &&
        req.user.userId !== file.recipient_id
      ) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      // Check expiry
      if (file.expires_at && file.expires_at < Math.floor(Date.now() / 1000)) {
        res.status(410).json({ error: 'File expired' })
        return
      }

      // Use file.id from DB (trusted) — not raw req.params (untrusted)
      const filePath = safeFilePath(file.id)
      if (!filePath) {
        res.status(400).json({ error: 'Invalid file ID' })
        return
      }

      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(filePath)
      } catch {
        res.status(404).json({ error: 'File not found on disk' })
        return
      }

      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Cache-Control', 'private, immutable, max-age=86400')
      res.setHeader('X-File-Id', file.id)
      res.setHeader('X-Mime-Hint', file.mime_hint ?? 'application/octet-stream')

      const stream = fs.createReadStream(filePath)
      stream.on('error', err => {
        console.error('File stream error:', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream file' })
        } else {
          res.destroy()
        }
      })
      stream.pipe(res)
    } catch (error) {
      console.error('File download error:', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' })
      }
    }
  }
)

// GET /files/:fileId — download an encrypted file blob (legacy JSON, use /:fileId/raw instead)
router.get(
  '/:fileId',
  requireSignature,
  downloadRateLimit,
  validateParams(FileIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const fileId = req.params.fileId!

      if (!req.user?.userId) {
        res.status(403).json({ error: 'Unauthorized' })
        return
      }

      const file = database.getFileById(fileId)
      if (!file) {
        res.status(404).json({ error: 'File not found' })
        return
      }

      // Access control: if recipient_id is set, only uploader or recipient may download
      if (
        file.recipient_id &&
        req.user.userId !== file.uploader_id &&
        req.user.userId !== file.recipient_id
      ) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      // Check expiry
      if (file.expires_at && file.expires_at < Math.floor(Date.now() / 1000)) {
        res.status(410).json({ error: 'File expired' })
        return
      }

      // Use file.id from DB (trusted) — not raw req.params (untrusted)
      const filePath = safeFilePath(file.id)
      if (!filePath) {
        res.status(400).json({ error: 'Invalid file ID' })
        return
      }
      try {
        await fs.promises.access(filePath)
      } catch {
        res.status(404).json({ error: 'File not found on disk' })
        return
      }

      const data = await fs.promises.readFile(filePath)
      res.json({
        fileId: file.id,
        data: data.toString('base64'),
        mimeHint: file.mime_hint,
        size: file.size,
      })
    } catch (error) {
      console.error('File download error:', error instanceof Error ? error.message : String(error))
      res.status(500).json({ error: 'Failed to download file' })
    }
  }
)

export default router
