const workpoolTestEntry = "@convex-dev/workpool/test";
const workpool: {
  register(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name: string): void;
} = await import(workpoolTestEntry);
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

type Modules = Parameters<
  TestConvex<SchemaDefinition<GenericSchema, boolean>>["registerComponent"]
>[2];

type GlobImportMeta = ImportMeta & { glob: (patterns: string[]) => Modules };
const modules = (import.meta as GlobImportMeta).glob([
  "./component/**/*.ts",
  "!./component/**/*.test.ts",
]);

export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "webPush",
) {
  t.registerComponent(name, schema, modules);
  workpool.register(t, `${name}/workpool`);
}
