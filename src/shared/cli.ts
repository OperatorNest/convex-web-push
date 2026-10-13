import { validateVapidSubject, generateVapidKeys, type VapidKeys } from "./vapid.js";

/** A CLI result carries the exit code and text written to standard output and error. */
export type CliResult = { code: number; stdout: string; stderr: string };

const USAGE = `Usage: convex-web-push generate-keys --subject <mailto-address-or-https-url>

Prints WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT as env lines.
`;

function formatEnvLines(keys: VapidKeys, subject: string): string {
  return [
    `WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `WEB_PUSH_VAPID_SUBJECT=${subject}`,
    "",
  ].join("\n");
}

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
  let subject: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--subject" && next) {
      subject = next;
      i++;
    } else if (arg?.startsWith("--subject=")) subject = arg.slice("--subject=".length);
    else return { code: 1, stdout: "", stderr: `Unknown argument: ${arg}\n${USAGE}` };
  }
  if (subject === undefined)
    return { code: 1, stdout: "", stderr: `Missing argument: --subject\n${USAGE}` };
  const subjectProblem = validateVapidSubject(subject);
  if (subjectProblem) return { code: 1, stdout: "", stderr: `${subjectProblem}\n` };
  const stdout = `${formatEnvLines(await generate(), subject)}
Set them on your Convex deployment, for example:
  pnpm exec convex env set WEB_PUSH_VAPID_PUBLIC_KEY '<value>'
  pnpm exec convex env set WEB_PUSH_VAPID_PRIVATE_KEY '<value>'
  pnpm exec convex env set WEB_PUSH_VAPID_SUBJECT '${subject.replaceAll("'", "'\"'\"'")}'
Keep WEB_PUSH_VAPID_PRIVATE_KEY secret and never commit it.
`;
  return { code: 0, stdout, stderr: "" };
}
