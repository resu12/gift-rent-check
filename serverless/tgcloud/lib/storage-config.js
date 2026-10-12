// Operator-owned application safety policy. This is not Telegram's physical
// quota. Raise it only after verifying platform capacity and database overhead.
export const storagePolicy = Object.freeze({budgetBytes:512*1048576});
