// Mailbox rules: the delivery lease and the line-preserving rewrite.
// Ported from `dsh-agent-teams/src/state.ts` (`readUnreadMailbox`,
// `mutateMailbox`, `claimMailboxDelivery`, `releaseMailboxDelivery`,
// `acknowledgeMailbox`, `stripLeadingBom`).
//
// Only the pure parts live here. The file reading and writing is the storage
// driver's job; what belongs to the core is *which* records change and *what*
// they become, because those rules decide whether a member is told about work.
import { MAILBOX_DELIVERY_LEASE_MS } from './constants.js'
import { isTeamMessage } from './entities.js'

/** Remove the optional UTF-8 BOM some editors prepend to JSON text. */
export function stripLeadingBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/**
 * Whether a message is still owed to its recipient.
 *
 * Unread means never acknowledged, **and** not currently leased. Expiry is
 * evaluated against the supplied `now` rather than read from a clock, so this
 * stays a pure function of its arguments — and there is no timer anywhere:
 * a stale lease is only noticed when someone next asks.
 *
 * @param message - the mailbox record.
 * @param now - current epoch milliseconds.
 * @returns true when the message should be delivered.
 */
export function isUnread(message, now) {
  return message.readAt === undefined
    && (message.deliveryClaimedAt === undefined || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS)
}

/** Filter a mailbox down to the messages still owed, oldest first. */
export function unreadMessages(messages, now) {
  return messages.filter(message => isUnread(message, now))
}

/** Lease a message to one delivery path, so two paths cannot both deliver it. */
export function claimDelivery(message, now) {
  return { ...message, deliveryClaimedAt: now }
}

/**
 * Drop a failed delivery's lease so the scheduler may retry it. The field is
 * removed rather than zeroed: `deliveryClaimedAt === undefined` is the "never
 * claimed" state the unread rule tests for.
 */
export function releaseDelivery(message) {
  const { deliveryClaimedAt: _claimed, ...released } = message
  return released
}

/**
 * Mark a message delivered and read. Both timestamps keep their first value, so
 * acknowledging twice does not move the recorded time.
 */
export function acknowledgeDelivery(message, now) {
  const { deliveryClaimedAt: _claimed, ...rest } = message
  return {
    ...rest,
    deliveredAt: message.deliveredAt ?? now,
    readAt: message.readAt ?? now,
  }
}

/**
 * Rewrite selected records in a JSONL mailbox, leaving everything else
 * byte-for-byte intact.
 *
 * Malformed lines are passed through unchanged rather than dropped: the file is
 * the durable record, and a rewrite that quietly discards a line nobody could
 * parse destroys the only evidence of what it was. Ids that appear in `ids` but
 * not in the file are ignored without error — the caller usually holds a
 * snapshot that may already be stale.
 *
 * @param raw - the mailbox file's whole text.
 * @param ids - message ids to rewrite.
 * @param mutate - the pure transform applied to each selected message.
 * @returns the new file text.
 */
export function mutateMailboxLines(raw, ids, mutate) {
  if (ids.length === 0) return raw
  const selected = new Set(ids)
  return raw.split('\n').map(rawLine => {
    const line = stripLeadingBom(rawLine)
    if (line.trim() === '') return rawLine
    let value
    try {
      value = JSON.parse(line)
    } catch {
      return rawLine
    }
    if (!isTeamMessage(value) || !selected.has(value.id)) return rawLine
    return JSON.stringify(mutate(value))
  }).join('\n')
}

/**
 * Parse a JSONL mailbox, reporting each unusable line instead of failing.
 *
 * One hand-damaged line must not make the whole team unreadable, but it must
 * not vanish either: `onMalformedLine` is how the damage reaches a diagnostic
 * surface rather than being swallowed.
 *
 * @param raw - the mailbox file's whole text.
 * @param onMalformedLine - called with the 1-based line number and the reason.
 * @returns the parsed messages, oldest first.
 */
export function parseMailboxLines(raw, onMalformedLine) {
  const messages = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = stripLeadingBom(lines[index])
    if (line.trim() === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      onMalformedLine?.(index + 1, new Error('invalid JSON'))
      continue
    }
    if (!isTeamMessage(value)) {
      onMalformedLine?.(index + 1, new Error('invalid message shape'))
      continue
    }
    messages.push(value)
  }
  return messages
}
