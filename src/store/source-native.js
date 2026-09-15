// The native source's name.
//
// Split from `sources.js` so the two source modules can name themselves without
// importing each other through the registry that holds them — the registry
// imports both, and a cycle through it would make the ids depend on the order
// the file happened to be read in.
//
// Native means "the append-only log this plugin writes". It is the only
// writable source, and that is not a flag anybody sets: the capability is
// whether the object has an `append`, and this one does.
export const SOURCE_ID = 'native'
