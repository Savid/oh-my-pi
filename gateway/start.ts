import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const role = process.argv[2];
if (role !== "broker" && role !== "gateway" && role !== "set-key") throw new Error("Expected broker, gateway or set-key");
process.umask(0o077);

// Provider API keys the broker can hold, with the prefix each key must carry.
const providerKeys = {
  anthropic: { env: "CLAUDE_SETUP_TOKEN", prefix: "sk-ant-oat", what: "a Claude subscription setup token, not a Console API key" },
  openrouter: { env: "OPENROUTER_API_KEY", prefix: "sk-or-", what: "an OpenRouter API key" },
  typesafe: { env: "TYPESAFE_API_KEY", prefix: "", what: "a TypeSafe API key" },
  "opencode-go": { env: "OPENCODE_GO_API_KEY", prefix: "", what: "an OpenCode Go API key" },
} as const;
type Provider = keyof typeof providerKeys;

function checkedKey(provider: Provider, key: string): string {
  const spec = providerKeys[provider];
  if (!key.startsWith(spec.prefix)) throw new Error(`${spec.env} must be ${spec.what}`);
  return key;
}

async function openStore() {
  const path = getAgentDbPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return SqliteAuthCredentialStore.open(path);
}

if (role === "set-key") {
  // `set-key <provider>` stores one key read from stdin, beside a running broker,
  // which picks up the change from SQLite: kubectl exec -i ... set-key openrouter < key
  const provider = process.argv[3];
  if (!(provider in providerKeys)) throw new Error(`Usage: set-key <${Object.keys(providerKeys).join("|")}> < key`);
  const key = (await Bun.stdin.text()).trim();
  if (!key) throw new Error("No key on stdin");
  const store = await openStore();
  await store.saveApiKey(provider, checkedKey(provider as Provider, key));
  await store.close();
  console.log(`saved ${provider} key`);
  process.exit(0);
}

if (role === "broker") {
  // Keys set in the environment are saved, replacing that provider's credential;
  // unset keys leave the vault alone, so logins and keys added by hand (set-key,
  // `auth-broker login`) survive restarts. The broker may start with none.
  const store = await openStore();
  for (const [provider, spec] of Object.entries(providerKeys) as [Provider, (typeof providerKeys)[Provider]][]) {
    const key = process.env[spec.env]?.trim();
    if (key) await store.saveApiKey(provider, checkedKey(provider, key));
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
