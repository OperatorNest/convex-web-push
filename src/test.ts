import { register as registerWorkpool } from "@convex-dev/workpool/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

type ComponentTest = TestConvex<SchemaDefinition<GenericSchema, boolean>>;
type Modules = Parameters<ComponentTest["registerComponent"]>[2];
type GlobImportMeta = ImportMeta & { glob: (patterns: string[]) => Modules };
const modules = (import.meta as GlobImportMeta).glob([
  "./component/**/*.ts",
  "!./component/**/*.test.ts",
]);

/** Registers this component and its child components with a consumer's convex-test instance under `name`. */
export function register(t: ComponentTest, name = "webPush") {
  t.registerComponent(name, schema, modules);
  registerWorkpool(t, `${name}/workpool`);
}
