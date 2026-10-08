import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const role = process.argv[2];
if (role !== "broker" && role !== "gateway") throw new Error("Expected broker or gateway");
process.umask(0o077);
if (role === "broker") {
  const claude = process.env.CLAUDE_SETUP_TOKEN?.trim();
  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  const typesafe = process.env.TYPESAFE_API_KEY?.trim();
  const opencodeGo = process.env.OPENCODE_GO_API_KEY?.trim();
  if (!claude && !openrouter && !typesafe && !opencodeGo) {
    throw new Error("Set CLAUDE_SETUP_TOKEN, OPENROUTER_API_KEY, TYPESAFE_API_KEY or OPENCODE_GO_API_KEY in the target's .env");
  }
  if (claude && !claude.startsWith("sk-ant-oat")) throw new Error("CLAUDE_SETUP_TOKEN must be a Claude subscription setup token, not a Console API key");
  if (openrouter && !openrouter.startsWith("sk-or-")) throw new Error("OPENROUTER_API_KEY must be an OpenRouter API key");
  const path = getAgentDbPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = await SqliteAuthCredentialStore.open(path);
  // The store mirrors .env: set keys replace their credential and unset keys
  // remove it. Setup tokens have no refresh token; the Anthropic adapter
  // recognizes their OAuth prefix.
  for (const [provider, key] of [
    ["anthropic", claude], ["openrouter", openrouter], ["typesafe", typesafe], ["opencode-go", opencodeGo],
  ] as const) {
    if (key) await store.saveApiKey(provider, key);
    else await store.deleteAuthCredentials(provider, "key unset in .env");
  }
  await store.close();
} else {
  process.env.OMP_AUTH_BROKER_TOKEN = readFileSync(`${process.env.HOME}/broker-token`, "utf8").trim();
}
delete process.env.CLAUDE_SETUP_TOKEN;
delete process.env.OPENROUTER_API_KEY;
delete process.env.TYPESAFE_API_KEY;
delete process.env.OPENCODE_GO_API_KEY;
// Run the CLI from its published sources: the `omp` bin is a bundle with its
// own copy of @oh-my-pi/pi-ai, so the fork's pi-ai sources would not apply to it.
const child = Bun.spawn([
  process.execPath, `${import.meta.dir}/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts`, `auth-${role}`, "serve",
  `--bind=0.0.0.0:${role === "broker" ? 8765 : 4000}`,
], { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}
process.exit(await child.exited);
