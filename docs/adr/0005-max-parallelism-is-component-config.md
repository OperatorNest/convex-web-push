# 0005: Workpool parallelism

`WEB_PUSH_MAX_PARALLELISM` sets the workpool's global concurrency: an integer from 1 to 200, default 10. Invalid values make sends fail with `WEB_PUSH_NOT_CONFIGURED`. Neither the client nor individual sends accept a parallelism option.
