// dsh-flow rules core — the pure state layer, shared by the host half and the
// canvas. Nothing here touches the filesystem, the network, or the host `ctx`:
// every module is a function of its arguments, which is what lets the whole
// layer run under `node --test` with no mocks (asserted by scripts/check.js).
//
// Module map — filled in as the port lands:
//   constants.js   enums, transition table, policy constants      (K2)
//   identifiers.js sanitizeKey / keyDigest                        (K6)
//   entities.js    isTeamState / isTeamMember / isTeamTask / …    (K1, K3)
//   dependencies.js unsatisfiedDependencies / taskDepthsById      (K4)
//   mailbox.js     unread rule and delivery-lease arithmetic      (K5)
//   paths.js       workspace path scope classification            (K13)
//   gates.js       validateCreateTask / evaluateQualityCompletion (K7, K8)
//   delivery.js    canDeclareDelivery / describeQualityLoop       (K9, K10)
//   coverage.js    buildCoverageMatrix                            (K11)
//   followup.js    planQualityFollowUp                            (K12)
//   profiles.js    profile key tables and topoSortTasks           (K14)
//   events.js      append-only team event schema                  (protocol)
//   project.js     events -> TeamState projection                 (protocol)

export {
  TASK_STATUS, TERMINAL_TASK_STATUSES, TASK_KINDS, REVIEW_VERDICTS, FINDING_SEVERITIES,
  MEMBER_STATUS, CAPTAIN_KEY, CAPTAIN_ASSIGNEE, MAILBOX_DELIVERY_LEASE_MS,
  TASK_TRANSITIONS, transitionError,
} from './constants.js'
export { sha256Hex } from './sha256.js'
export { MAX_KEY_LENGTH, keyDigest, sanitizeKey } from './identifiers.js'
export {
  isReviewPolicy, isReviewFinding, isAcceptanceResult, isCommandResult,
  normalizeBlankOptionalTaskFields, hasValidQualityTaskFields,
  isTeamMember, isTeamProfileSnapshot, coerceProfileSnapshot,
  isTeamTask, isTeamState, isTeamMessage, coerceTeamState,
} from './entities.js'
export { unsatisfiedDependencies, taskDepthsById, taskVisualState, danglingDependencies } from './dependencies.js'
export { stripLeadingBom, isUnread, unreadMessages, claimDelivery, releaseDelivery, acknowledgeDelivery, mutateMailboxLines, parseMailboxLines } from './mailbox.js'
export { PATH_CLASSIFICATIONS, normalizeWorkspacePath, pathMatchesScope, isDefaultExcluded, classifyChangedPath, collectChangedPaths, inScopeOverlap } from './paths.js'
