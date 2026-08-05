import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  EventEnvelopeSchema,
  TaskSchema,
  AgentSchema,
  ResourceClaimSchema,
} from "./entities.js";

/**
 * Generates JSON Schema files from the zod source-of-truth schemas.
 * These are the canonical wire-contract artifacts that non-TypeScript
 * consumers (other languages, external tooling) read.
 *
 * Run via `pnpm --filter @gitamesh/protocol generate-schemas`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "schemas");

mkdirSync(outDir, { recursive: true });

const targets: Array<[string, unknown]> = [
  ["EventEnvelope", EventEnvelopeSchema],
  ["Task", TaskSchema],
  ["Agent", AgentSchema],
  ["ResourceClaim", ResourceClaimSchema],
];

for (const [name, schema] of targets) {
  const jsonSchema = zodToJsonSchema(schema as never, name);
  const outPath = join(outDir, `${name}.schema.json`);
  writeFileSync(outPath, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf-8");
  // eslint-disable-next-line no-console
  console.log(`wrote ${outPath}`);
}
