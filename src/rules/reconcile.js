// State → events: the inverse of `project.js`.
//
// The dispatch loop is ported from agent-teams and mutates a team record in
// place before handing it back to be saved. The store has no snapshot to save,
// so this module is the bridge: it reads the difference between the record the
// caller holds and the state its log already implies, and returns the events
// that would produce it.
//
// Three rules make this safe rather than clever.
//
// The first is that the comparison is against the *log*, not against a snapshot
// the caller read earlier. A caller that already recorded its own events before
// mutating — the rollback path does exactly that, because a failure has a
// reason no diff can recover — therefore diffs to nothing here instead of
// recording the same fact twice.
//
// The second is that a difference this cannot express is an **error**, not a
// silent drop. Quietly discarding a mutation would recreate exactly the failure
// the log exists to prevent: a change that happened and left no trace. A task's
// plan-time fields are the case that matters — `subject`, `acceptance` and
// friends have no update event because they are frozen once the team runs, so a
// caller that changed one is told so rather than ignored.
//
// The third is that the answer is **checked before it is returned**. The events
// are folded back onto the state with the same reducer the reader uses, and the
// result must equal what the caller asked for. Guessing which fields an event
// implies is what would let the log and the record drift; folding and comparing
// is what makes that impossible to ship.
import { reduceTeamEvent } from './project.js'

/**
 * Fields the projection owns, so a difference in them is not a change.
 *
 * `joinedAt`, `createdAt` and `updatedAt` are stamped from the event's own
 * timestamp. A caller holding a projected record has them filled in already;
 * comparing them would mean the log's clock and the caller's clock had to agree,
 * which is a requirement with no purpose.
 */
const DERIVED_FIELDS = Object.freeze(['joinedAt', 'createdAt', 'updatedAt'])

/**
 * Task fields an update event can carry.
 *
 * Everything else on a task is a plan field: it was decided when the team was
 * created and the runtime has no vocabulary for changing it, because a live
 * member may be holding an attempt against it.
 */
const TASK_MUTABLE_FIELDS = Object.freeze([
  'status', 'assignee', 'attempt', 'attemptId', 'handoffId', 'reassigning',
  'output', 'verdict', 'acceptanceResults', 'changedPaths',
])

/**
 * Fields present in `after` whose value `before` did not carry.
 *
 * A key whose value is `undefined` is never reported: setting a field to
 * nothing is not something an update event can say, because JSON drops the key
 * on the way to disk and the log would then describe a different change than
 * the one that was made. Clearing a field is therefore always a difference the
 * reconcile cannot express, which is what the residual check below is for.
 */
function changedFields(before, after, ignored) {
  const patch = {}
  for (const [key, value] of Object.entries(after)) {
    if (ignored.includes(key) || value === undefined) continue
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue
    patch[key] = value
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/**
 * Every remaining difference between two records, named field by field.
 *
 * Walks members and tasks individually rather than comparing the arrays as
 * wholes, so the answer reads as "tasks.t1.output" instead of "tasks", and so
 * the fields the projection stamps never register as differences at all.
 */
function differences(before, after) {
  const found = []
  for (const [key, value] of Object.entries(after)) {
    if (key === 'members' || key === 'tasks') continue
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue
    found.push(key)
  }
  const oneLevel = (label, previous, next) => {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (DERIVED_FIELDS.includes(key)) continue
      if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue
      found.push(`${label}.${key}`)
    }
  }
  for (const member of after.members ?? []) {
    const previous = before.members.find(candidate => candidate.name === member.name)
    if (previous === undefined) { found.push(`members.${member.name}`); continue }
    oneLevel(`members.${member.name}`, previous, member)
  }
  for (const member of before.members) {
    if (!(after.members ?? []).some(candidate => candidate.name === member.name)) {
      found.push(`members.${member.name} (present in the log, absent from the record)`)
    }
  }
  for (const task of after.tasks ?? []) {
    const previous = before.tasks.find(candidate => candidate.id === task.id)
    if (previous === undefined) { found.push(`tasks.${task.id}`); continue }
    oneLevel(`tasks.${task.id}`, previous, task)
  }
  for (const task of before.tasks) {
    if (!(after.tasks ?? []).some(candidate => candidate.id === task.id)) {
      found.push(`tasks.${task.id} (present in the log, absent from the record)`)
    }
  }
  return found
}

/**
 * A member as `member.added` carries it: the record minus what the log stamps.
 *
 * An empty id is dropped rather than carried: a staged member has no session
 * yet, the projection fills the blank in either way, and a payload asserting
 * `id: ""` reads as a claim about a session that does not exist.
 */
function memberRecord(member) {
  const record = {}
  for (const [key, value] of Object.entries(member)) {
    if (DERIVED_FIELDS.includes(key) || key === 'status') continue
    if (key === 'id' && value === '') continue
    record[key] = value
  }
  return record
}

/** A task as `task.created` carries it: the record minus what the log stamps. */
function taskRecord(task) {
  const record = {}
  for (const [key, value] of Object.entries(task)) {
    if (DERIVED_FIELDS.includes(key)) continue
    if (key === 'status' && value === 'pending') continue
    record[key] = value
  }
  return record
}

/** The key a member is addressed by in an event payload. */
const memberKey = member => (member.id === undefined || member.id === '' ? member.name : member.id)

/** Fold a batch of candidate events onto a state, leaving the state untouched. */
export function applyEvents(state, events) {
  let next = state
  for (const event of events) next = reduceTeamEvent(next, event)
  return next
}

/**
 * Turn a caller's in-place edits into the events that describe them.
 *
 * @param before - the state the team's log currently implies.
 * @param after - the same team, as the caller mutated it.
 * @param at - the timestamp for the events produced.
 * @param seq - the sequence number of the first event; the rest follow it.
 * @returns the events to append, in the order they must be applied.
 * @throws when a difference has no event to carry it — see the header.
 */
export function teamDiffEvents(before, after, at, seq) {
  if (before === undefined) {
    throw new Error('cannot diff against a team no log describes; record its team.created event first')
  }
  const events = []
  const push = (type, payload) => { events.push({ type, at, seq: seq + events.length, ...payload }) }

  for (const member of after.members ?? []) {
    const previous = member.id === undefined || member.id === ''
      ? before.members.find(candidate => candidate.name === member.name)
      : before.members.find(candidate => candidate.id === member.id)
    if (previous === undefined) {
      push('member.added', { member: memberRecord(member) })
      continue
    }
    const patch = changedFields(previous, member, DERIVED_FIELDS)
    if (patch !== undefined) push('member.updated', { id: memberKey(member), patch })
  }
  // Removal is a tombstone, not a deletion: `member.removed` leaves the member
  // in the projection marked `removed`, because the tasks it touched and the
  // mail it received still refer to it by name. A caller that spliced the
  // member out of the array is therefore asking for something the log does not
  // describe, and is told so rather than quietly handed a tombstone.
  for (const member of before.members) {
    if (member.status === 'removed') continue
    if ((after.members ?? []).some(candidate => candidate.name === member.name)) continue
    throw new Error(
      `member "${member.name}" was deleted from the record, but removal is a tombstone; `
      + 'record it with an explicit member.removed event instead',
    )
  }
  for (const task of before.tasks) {
    if ((after.tasks ?? []).some(candidate => candidate.id === task.id)) continue
    throw new Error(`task "${task.id}" was deleted from the record; the log has no event that removes a task`)
  }

  for (const task of after.tasks ?? []) {
    const previous = before.tasks.find(candidate => candidate.id === task.id)
    if (previous === undefined) {
      push('task.created', { task: taskRecord(task) })
      continue
    }

    // Frozen first: a diff that cannot be expressed must fail before anything
    // is returned, so a rejected reconcile leaves the caller's log untouched.
    const frozen = changedFields(previous, task, [...DERIVED_FIELDS, ...TASK_MUTABLE_FIELDS])
    if (frozen !== undefined) {
      throw new Error(
        `task "${task.id}" changed ${Object.keys(frozen).join(', ')}, which the event log cannot express; `
        + 'a task\'s plan fields are frozen once the team is created',
      )
    }

    const startedAttempt = task.attemptId !== undefined && task.attemptId !== previous.attemptId
    if (startedAttempt) {
      push('task.attempt_started', {
        id: task.id,
        attemptId: task.attemptId,
        attempt: task.attempt ?? (previous.attempt ?? 0) + 1,
        ...task.assignee === undefined ? {} : { assignee: task.assignee },
      })
    }

    // Starting an attempt already implies `claimed`, so a status difference it
    // accounts for is not a second fact worth recording.
    const impliedStatus = startedAttempt ? 'claimed' : previous.status
    if (task.status === 'completed' && impliedStatus !== 'completed') {
      push('task.completed', {
        id: task.id,
        ...task.verdict === undefined ? {} : { verdict: task.verdict },
        ...task.acceptanceResults === undefined ? {} : { acceptanceResults: task.acceptanceResults },
        ...task.changedPaths === undefined ? {} : { changedPaths: task.changedPaths },
        ...task.output === undefined ? {} : { output: task.output },
      })
    } else if (task.status !== impliedStatus) {
      push('task.transitioned', { id: task.id, from: impliedStatus, to: task.status })
    }
  }

  // The check that makes the rest trustworthy. `applyEvents` is the reader's own
  // reducer, so anything the events failed to carry shows up here as a leftover
  // difference rather than as a record that quietly disagrees with its log.
  const residual = differences(applyEvents(before, events), after)
  if (residual.length > 0) {
    throw new Error(
      `the event log has no vocabulary for ${residual.join(', ')}; nothing was recorded. `
      + 'Record the change as an explicit event instead of editing the record.',
    )
  }
  return events
}
