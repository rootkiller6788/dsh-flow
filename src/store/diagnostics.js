// What was damaged, and where — the import report.
//
// The rule this exists for is `AGENTS.md:113` — *never silently skip a missing
// referent* — applied to the one boundary where skipping is the tolerant
// behaviour: a damaged line in a file. Parsing must not stop (one bad line does
// not invalidate the rest of a log), but nothing about it may be quiet either,
// because silence is how data corruption becomes a mystery months later.
//
// **Deduplicated, and that is load-bearing rather than tidy.** The canvas polls
// the team snapshot once a second, and every poll re-reads the same mailboxes
// and the same event logs. Recording each sighting would grow the report without
// bound and turn a single damaged line into a wall of identical entries — the
// opposite of making it visible.
//
// Entries are kept for the life of the process rather than cleared per poll: a
// reader who fixes a file finds out by the entry disappearing after a restart,
// which is honest, whereas a per-poll report would look fixed the moment they
// stopped looking at the damaged directory.

/**
 * The identity of one finding, for deduplication.
 *
 * Built by `JSON.stringify` rather than by joining with a separator: the parts
 * are a kind, three identifiers and an error message, and any character that
 * could separate them can also occur inside them. Two findings that differed
 * only in where the separator fell would dedupe into one, and the report would
 * quietly lose an entry — which is the failure this whole module exists against.
 *
 * `line` is optional: a damaged line has one, a team that cannot be projected
 * does not.
 */
const keyOf = entry => JSON.stringify([entry.kind, entry.teamId, entry.member ?? '', entry.line ?? '', entry.reason])

/**
 * Build the collector.
 *
 * @returns `{ record, forTeam, summary, count }`.
 */
export function createFlowDiagnostics() {
  const seen = new Set()
  /** @type {{ kind: string, teamId: string, member?: string, line?: number, reason: string }[]} */
  const entries = []

  return {
    /**
     * Record one damaged thing.
     *
     * @param entry - `{ kind, teamId, member?, line?, reason }`, where `kind` is
     *   which reader found it: `'log'` for a team's own event log, `'mailbox'`
     *   for a member's inbox, `'team'` for a record that cannot be projected at
     *   all. They are distinguished because they mean different things to a
     *   reader — a damaged mailbox loses messages, a damaged log loses what
     *   happened, and an unprojectable team loses the team.
     */
    record(entry) {
      const key = keyOf(entry)
      if (seen.has(key)) return
      seen.add(key)
      entries.push(entry)
    },

    /** One team's damage, in the order it was first seen. */
    forTeam(teamId) {
      return entries.filter(entry => entry.teamId === teamId)
    },

    /**
     * The whole report: every team that has damage, and how much.
     *
     * Grouped by team rather than flat, because "which team is affected" is the
     * first question and a flat list of line numbers does not answer it.
     */
    summary() {
      const byTeam = new Map()
      for (const entry of entries) {
        if (!byTeam.has(entry.teamId)) byTeam.set(entry.teamId, [])
        byTeam.get(entry.teamId).push(entry)
      }
      return {
        total: entries.length,
        teams: [...byTeam].map(([teamId, teamEntries]) => ({ teamId, count: teamEntries.length })),
      }
    },

    /** How many damaged things have been recorded. */
    count() {
      return entries.length
    },
  }
}
