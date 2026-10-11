// The ready marker is written with candidate/gate completion. The consumed
// marker is written with the first full drain in the deletion transaction.
export const FIRST_DELETE_READY = "PRUNE_FIRST_DELETE_READY:v1";
export const FIRST_DELETE_CONSUMED = "PRUNE_FIRST_DELETE_CONSUMED:";
export const FIRST_DELETE_UNPROVEN = "PRUNE_FIRST_DELETE_UNPROVEN:";
