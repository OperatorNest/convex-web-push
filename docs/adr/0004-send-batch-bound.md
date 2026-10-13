# 0004: Batch transaction bounds

A client batch call invokes one component mutation and accepts at most 100 supplied user IDs. Each step examines at most 150 subscriptions, including expired rows, and reserves room for 50 before starting another user. Scheduled mutations continue deferred users. Test mode is fixed when the batch is created; each step rechecks configuration and the public-key fingerprint. Apps send larger audiences from actions in calls of at most 100 IDs.
