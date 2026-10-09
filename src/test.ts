import { register as registerWorkpool } from "@convex-dev/workpool/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

type Modules = Parameters<
  TestConvex<SchemaDefinition<GenericSchema, boolean>>["registerComponent"]
>[2];

const modules = import.meta.glob(["./component/**/*.ts", "!./component/**/*.test.ts"]) as Modules;

/** Registers the web push component and its workpool child with a `convex-test` instance. */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "webPush",
) {
  t.registerComponent(name, schema, modules);
  registerWorkpool(t, `${name}/workpool`);
}
