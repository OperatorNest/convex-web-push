# 0008: Subscription revisions and removal generations

Each registration increments its subscription revision. A delivery attempt captures that revision before checking eligibility. Completion updates subscription health only when both owner and revision still match.

Each user has a registration generation. Removing all subscriptions increments it and deletes rows from earlier generations in 100-row steps. Registrations after removal begins use the new generation, including refreshed existing endpoints, and survive the scheduled deletion.

Delivery failures store fixed package error data; free-form provider and native exception text is discarded. Error data has `code`, `message` and optional `providerStatus`.
