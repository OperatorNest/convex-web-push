# 0008: Subscription revisions and removal generations

Each registration increments its subscription revision. A delivery attempt captures that revision before checking eligibility. Completion updates subscription health only when both owner and revision still match.

Each user has a registration generation. Removing all subscriptions increments it and deletes rows from earlier generations in 100-row steps. Registrations after removal begins use the new generation, including refreshed existing endpoints, and survive the scheduled deletion. The generation counter lives in one `subscriptionOwners` row per user and test mode, created by the first registration or removal. Cleanup never deletes that row: deleting it would reset the counter to 0, and a pending removal continuation would then delete registrations made after the reset. The table grows by one row per distinct user and test mode.

Delivery failures store fixed package error data; free-form provider and native exception text is discarded. Error data has `code`, a fixed `message` and optional provider details; only provider and network errors carry `retryable`.
