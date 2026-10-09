# 0001: exactOptionalPropertyTypes stays off

## Context

`exactOptionalPropertyTypes` checks omitted optional properties. With it on, `tsc` reports four errors, all in
`convex-helpers/server/stream.ts`, a `.ts` source file under `node_modules` that `skipLibCheck`
cannot silence. It is pulled in by `convex-helpers/server/pagination`, which `notifications.listForUser`
needs (components cannot call the built-in `.paginate()`). The errors, from `tsc -p tsconfig.build.json`
with convex-helpers 0.1.126:

```
stream.ts(445,5): error TS2375: Type '{ page: T[]; isDone: boolean; continueCursor: string; pageStatus: "SplitRecommended" | "SplitRequired" | undefined; splitCursor: string | undefined; }' is not assignable to type 'PaginationResult<T>' with 'exactOptionalPropertyTypes: true'.
stream.ts(670,3): error TS2416: Property 'reflect' in type 'StreamQueryInitializer<Schema, T>' is not assignable to the same property in base type 'StreamableQuery<Schema, T, "by_creation_time">'.
stream.ts(720,3): error TS2416: Property 'reflect' in type 'StreamQuery<Schema, T, IndexName>' is not assignable to the same property in base type 'StreamableQuery<Schema, T, IndexName>'.
stream.ts(754,3): error TS2416: Property 'reflect' in type 'OrderedStreamQuery<Schema, T, IndexName>' is not assignable to the same property in base type 'StreamableQuery<Schema, T, IndexName>'.
```

All four are `undefined` versus omitted property mismatches in upstream code.

## Decision

Leave the flag off in `tsconfig.json`. The code is still written to be clean under it: optional
fields are omitted rather than set to `undefined`, public client option types accept
`| undefined`, and the example app's `tsconfig.json` has the flag on and passes.

## Consequences

Re-enable the flag once convex-helpers fixes `stream.ts`. Until then a regression in omission
semantics inside `src/` would not be caught by the compiler, only by the example app typecheck and tests.
