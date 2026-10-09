/** Active plus paused subscriptions kept per user. Sending fans out to at most this many. */
export const MAX_SUBSCRIPTIONS_PER_USER = 50;
/** Users accepted by one `sendBatch` call. */
export const MAX_BATCH_USERS = 100;
/** Delivery rows one transaction may insert before a batch continues in a scheduled mutation. */
export const BATCH_DELIVERY_BUDGET = 150;
export const CLEANUP_BUDGET = 500;
export const PURGE_BATCH = 100;
