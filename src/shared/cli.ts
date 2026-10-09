import { validateVapidSubject, generateVapidKeys, type VapidKeys } from "./vapid.js";

export type CliResult = { code: number; stdout: string; stderr: string };

const USAGE = `Usage: convex-web-push generate-keys [--subject mailto:you@example.com]

Prints VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT as env lines.
`;

function formatEnvLines(keys: VapidKeys, subject: string): string {
  return [
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `VAPID_SUBJECT=${subject}`,
    "",
  ].join("\n");
}

/** Pure CLI entry point. The `bin` script only forwards `argv` and prints the result. */
export async function runCli(
  argv: readonly string[],
  generate: () => Promise<VapidKeys> = generateVapidKeys,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    return { code: command === undefined ? 1 : 0, stdout: USAGE, stderr: "" };
  }
  if (command !== "generate-keys") {
    return { code: 1, stdout: "", stderr: `Unknown command: ${command}\n${USAGE}` };
  }
  let subject = "mailto:you@example.com";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--subject" && next) {
      subject = next;
      i++;
    } else if (arg?.startsWith("--subject=")) subject = arg.slice("--subject=".length);
    else return { code: 1, stdout: "", stderr: `Unknown argument: ${arg}\n${USAGE}` };
  }
  const subjectProblem =
    subject === "mailto:you@example.com" ? null : validateVapidSubject(subject);
  if (subjectProblem) return { code: 1, stdout: "", stderr: `${subjectProblem}\n` };
  const stdout = `${formatEnvLines(await generate(), subject)}
Set them on your Convex deployment, for example:
  npx convex env set VAPID_PUBLIC_KEY <value>
  npx convex env set VAPID_PRIVATE_KEY <value>
  npx convex env set VAPID_SUBJECT ${subject}
Keep VAPID_PRIVATE_KEY secret and never commit it.
`;
  return { code: 0, stdout, stderr: "" };
}
