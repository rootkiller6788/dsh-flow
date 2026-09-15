// The per-member inbox: one JSONL file per member, under the team's directory.
//
// The rules for *which* message changes live in `rules/mailbox.js`; this is the
// driver that applies them to a file. Splitting it that way is what lets the
// delivery-lease arithmetic be tested as arithmetic instead of as a sequence of
// file writes — and the lease is the only thing standing between two concurrent
// kicks and a member being told the same thing twice.
//
// A mailbox is a log with a mutable tail, not a log. Messages are appended and
// never removed, but their read and lease stamps are rewritten in place, which
// is why `mutateMailboxLines` is line-preserving: a rewrite that reformatted
// untouched lines would make every delivery a whole-file diff.
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acknowledgeDelivery, claimDelivery, mutateMailboxLines, parseMailboxLines,
  releaseDelivery, sanitizeKey, unreadMessages,
} from '../rules/index.js'

/** The directory holding a team's inboxes. */
export const MAIL_DIRECTORY = 'mail'
/** The extension every inbox file carries. */
export const MAIL_FILE_SUFFIX = '.jsonl'

/**
 * A store over one team directory's inboxes.
 *
 * @param options.teamDir - `(teamId) => string`, the team's directory.
 * @param options.now - clock, injectable so a lease is reproducible in a test.
 * @param options.onMalformedLine - `(teamId, memberName, line, error) => void`.
 */
export function createMailboxStore(options) {
  const { teamDir } = options
  const now = options.now ?? (() => Date.now())

  /** Where one member's inbox lives. */
  const mailDir = teamId => join(teamDir(teamId), MAIL_DIRECTORY)
  // A member's name is deployment-supplied text, so it is folded to a safe key
  // before it ever reaches a path. `sanitizeKey` is total — a name with no
  // letters or digits at all is digested rather than emptied — which is what
  // makes the result safe to join without a further check here.
  const mailPath = (teamId, memberName) => (
    join(mailDir(teamId), `${sanitizeKey(memberName)}${MAIL_FILE_SUFFIX}`)
  )

  const readIfPresent = async path => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  const report = (teamId, memberName) => (line, error) => {
    options.onMalformedLine?.(teamId, memberName, line, error)
  }

  /** Rewrite only the selected messages, atomically. */
  const rewrite = async (teamId, memberName, ids, mutate) => {
    const path = mailPath(teamId, memberName)
    const raw = await readIfPresent(path)
    if (raw === undefined) return
    const next = mutateMailboxLines(raw, ids, mutate)
    if (next === raw) return
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, next, 'utf8')
    await rename(temporary, path)
  }

  /** Every message the member has, oldest first. */
  const readMailbox = async (teamId, memberName) => {
    const raw = await readIfPresent(mailPath(teamId, memberName))
    return raw === undefined ? [] : parseMailboxLines(raw, report(teamId, memberName))
  }

  return {
    readMailbox,

    /**
     * The messages still owed to the member.
     *
     * Lease expiry is evaluated here against the store's clock rather than
     * being stored, so a lease that lapsed while nothing was running is simply
     * not seen as held — there is no timer anywhere in this design.
     */
    async readUnreadMailbox(teamId, memberName) {
      return unreadMessages(await readMailbox(teamId, memberName), now())
    },

    /**
     * Append one message to the member's inbox.
     *
     * `open(..., 'a')` rather than a read-modify-write: two senders appending at
     * once must both land, and the alternative is a lost message.
     */
    async appendMessage(teamId, memberName, message) {
      await mkdir(mailDir(teamId), { recursive: true })
      const handle = await open(mailPath(teamId, memberName), 'a')
      try {
        await handle.write(`${JSON.stringify(message)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
    },

    /**
     * Lease messages to this delivery path.
     *
     * Claiming is what stops a second kick from delivering the same message
     * while the first is still in flight; the lease expires rather than needing
     * to be released, so a crash mid-delivery costs one retry, not the message.
     */
    async claimDelivery(teamId, memberName, ids) {
      const at = now()
      await rewrite(teamId, memberName, ids, message => claimDelivery(message, at))
    },

    /** Give a failed delivery's messages back for the next kick to retry. */
    async releaseDelivery(teamId, memberName, ids) {
      await rewrite(teamId, memberName, ids, releaseDelivery)
    },

    /** Mark messages delivered and read; the first timestamp is kept. */
    async acknowledgeDelivery(teamId, memberName, ids) {
      const at = now()
      await rewrite(teamId, memberName, ids, message => acknowledgeDelivery(message, at))
    },

    /** Inbox file names, without their extension. */
    async listMailboxes(teamId) {
      try {
        const entries = await readdir(mailDir(teamId), { withFileTypes: true })
        return entries
          .filter(entry => entry.isFile() && entry.name.endsWith(MAIL_FILE_SUFFIX) && !entry.name.startsWith('.'))
          .map(entry => entry.name.slice(0, -MAIL_FILE_SUFFIX.length))
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
    },
  }
}
