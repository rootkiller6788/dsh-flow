// The native source: the append-only log this plugin writes.
//
// Native means "ours" — as opposed to the imported `.agent-teams/` records
// beside it. It is the only writable source, and that is not a flag anybody
// sets: the capability query answers `canAppend() === true`, and the `append`
// method it pairs with is present here and absent everywhere else.
//
// A thin adapter rather than an interface the store implements, because the
// store is used directly by far more code than the registry is — making every
// caller go through a source object to reach its own log would be ceremony
// without a second implementation to justify it.
//
// This module also owns the source's own name, so the two source modules can
// name themselves without importing each other through the registry that holds
// them: the registry imports both, and a cycle through it would make the ids
// depend on the order the file happened to be read in.
import { isTeamId } from '../rules/index.js'

/** This source's name in the registry. */
export const SOURCE_ID = 'native'

/**
 * Build the native source over a store service.
 *
 * @param service - the store's service, whose log is the record.
 * @returns a source the registry can hold.
 */
export function createNativeSource(service) {
  return {
    id: SOURCE_ID,
    describe() {
      return {
        id: SOURCE_ID,
        writable: true,
        origin: "this deployment's own team log",
        note: 'the log is the record; state.json is a reading of it that can be rebuilt',
      }
    },
    canEnumerate: () => true,
    canLoad: teamId => isTeamId(teamId),
    canAppend: () => true,
    async enumerate() {
      return (await service.listTeamIds()).map(teamId => ({ teamId }))
    },
    load: teamId => service.readTeamEvents(teamId),
    readMailbox: (teamId, memberName, onMalformedLine) => (
      service.readMailbox(teamId, memberName, onMalformedLine)
    ),
    /** The one operation only a source that can append has at all. */
    append: (teamId, events) => service.appendEvents(teamId, events),
  }
}
