#!/usr/bin/env node
/**
 * create-stream-estate — one-command onboarding for the Stream Estate API V2 (beta).
 *
 *   npx -p @streamestate/sdk create-stream-estate
 *
 * Zero dependencies, ESM, Node >= 18 (needs global fetch).
 *
 * What it does:
 *   1. Finds an API key (--key, then $STREAM_ESTATE_API_KEY, then a prompt).
 *   2. Writes STREAM_ESTATE_API_KEY to ./.env — never clobbering a different
 *      existing value without asking first.
 *   3. Makes one real API call (GET /sources, no credit charged) so you can see the key work.
 *   4. Prints the docs link and the MCP install line.
 *
 * Endpoint and header from https://next.docs.stream.estate/openapi.json: GET /sources,
 * header `X-API-KEY`, plain JSON array response.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";

const API_BASE = "https://api-v2.stream.estate";
const TEST_PATH = "/sources";
const DOCS_URL = "https://next.docs.stream.estate";
const SIGNUP_URL = "https://console.stream.estate/signup";
const KEYS_URL = "https://console.stream.estate/api-keys";
const ENV_VAR = "STREAM_ESTATE_API_KEY";
const MCP_LINE =
  'claude mcp add --transport http streamestate https://api-v2.stream.estate/mcp --header "X-API-KEY: <your_key>"';

const color = stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold: (s) => (color ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (color ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (color ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (color ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (color ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (color ? `\x1b[36m${s}\x1b[0m` : s),
};

const HELP = `
${c.bold("create-stream-estate")} — set up the Stream Estate API V2 (beta) in the current directory.

${c.bold("Usage")}
  npx -p @streamestate/sdk create-stream-estate [options]

${c.bold("Options")}
  -k, --key <key>     API key to use. Falls back to $${ENV_VAR}, then a prompt.
  -y, --yes           Never prompt. Keeps any existing .env value as-is.
      --env-file <p>  Env file to write (default: ./.env).
      --no-env        Do not touch any .env file.
      --skip-test     Do not make the test API request.
  -h, --help          Show this help.

${c.bold("What it does")}
  1. Writes ${ENV_VAR}=... to ./.env (asks before replacing a different value).
  2. Runs one real request against GET ${API_BASE}${TEST_PATH}
     and prints the HTTP status, how long it took, and a one-line sample.
  3. Prints where to go next.

Get a key at ${c.cyan(SIGNUP_URL)} — the API V2 is free during the beta.
`;

function parseArgs(argv) {
  const opts = {
    key: null,
    yes: false,
    envFile: ".env",
    writeEnv: true,
    test: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "-k":
      case "--key":
        opts.key = argv[++i] ?? null;
        break;
      case "--env-file":
        opts.envFile = argv[++i] ?? ".env";
        break;
      case "--no-env":
        opts.writeEnv = false;
        break;
      case "--skip-test":
        opts.test = false;
        break;
      default:
        if (arg.startsWith("--key=")) opts.key = arg.slice("--key=".length);
        else if (arg.startsWith("--env-file=")) opts.envFile = arg.slice("--env-file=".length);
        else {
          console.error(`Unknown option: ${arg}\nRun with --help for usage.`);
          process.exit(2);
        }
    }
  }
  return opts;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read the value of `key` from a dotenv-style file body. Last assignment wins. */
function readEnvValue(body, key) {
  let value = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    let raw = match[2].trim();
    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1)
    ) {
      raw = raw.slice(1, -1);
    }
    value = raw;
  }
  return value;
}

/** Replace the assignment of `key` in place, or append it. */
function upsertEnvValue(body, key, value) {
  const lines = body.split(/\r?\n/);
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && pattern.test(line.trim())) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (replaced) return out.join("\n");
  const prefix = body.length === 0 || body.endsWith("\n") ? body : `${body}\n`;
  return `${prefix}${key}=${value}\n`;
}

function maskKey(key) {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}

async function prompt(question, { silent = false } = {}) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (!silent) return (await rl.question(question)).trim();
    // Hide typed characters for the key prompt.
    const onData = (char) => {
      if (["\n", "\r", ""].includes(char.toString())) return;
      stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
    };
    stdin.on("data", onData);
    try {
      const answer = await rl.question(question);
      stdout.write("\n");
      return answer.trim();
    } finally {
      stdin.off("data", onData);
    }
  } finally {
    rl.close();
  }
}

async function confirm(question, fallback = false) {
  if (!stdin.isTTY) return fallback;
  const answer = await prompt(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `);
  if (!answer) return fallback;
  return /^y(es)?$/i.test(answer);
}

async function resolveKey(opts) {
  if (opts.key) return { key: opts.key, source: "--key" };
  if (process.env[ENV_VAR]) return { key: process.env[ENV_VAR], source: `$${ENV_VAR}` };

  if (opts.yes || !stdin.isTTY) {
    console.error(
      c.red(`No API key.`) +
        ` Pass --key <key> or set $${ENV_VAR}.\nGet one at ${SIGNUP_URL}`
    );
    process.exit(1);
  }

  console.log(`Get an API key at ${c.cyan(SIGNUP_URL)} (Console → API keys).\n`);
  const key = await prompt("Stream Estate API V2 key: ", { silent: true });
  if (!key) {
    console.error(c.red("No key entered — aborting."));
    process.exit(1);
  }
  return { key, source: "prompt" };
}

async function writeEnvFile(opts, key) {
  const path = resolve(process.cwd(), opts.envFile);
  const present = await exists(path);
  const body = present ? await readFile(path, "utf8") : "";
  const current = readEnvValue(body, ENV_VAR);

  if (current === key) {
    console.log(`${c.green("✓")} ${opts.envFile} already has ${ENV_VAR} set to this key.`);
    return;
  }

  if (current !== null && current !== "") {
    // Never silently replace someone else's key.
    console.log(
      c.yellow(`! ${opts.envFile} already sets ${ENV_VAR} to ${maskKey(current)}.`)
    );
    const ok = await confirm(`  Replace it with ${maskKey(key)}?`, false);
    if (!ok) {
      console.log(`${c.dim("·")} Keeping the existing ${ENV_VAR} value.`);
      return;
    }
  }

  await writeFile(path, upsertEnvValue(body, ENV_VAR, key), "utf8");
  console.log(
    `${c.green("✓")} ${present ? "Updated" : "Created"} ${opts.envFile} with ${ENV_VAR}=${maskKey(key)}`
  );
}

async function testRequest(key) {
  const url = `${API_BASE}${TEST_PATH}`;
  console.log(`\n${c.bold("Test request")} ${c.dim(`GET ${url}`)}`);

  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      headers: { "X-API-KEY": key, Accept: "application/json" },
    });
  } catch (err) {
    console.log(`${c.red("✗")} Request failed after ${Date.now() - started} ms: ${err.message}`);
    return false;
  }
  const elapsed = Date.now() - started;

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* non-JSON body — reported raw below */
  }

  if (!response.ok) {
    console.log(`${c.red("✗")} HTTP ${response.status} ${response.statusText} in ${elapsed} ms`);
    const detail = payload?.detail || payload?.message || text.slice(0, 200);
    if (detail) console.log(`  ${c.dim(detail)}`);
    if (response.status === 401 || response.status === 403) {
      console.log(`  ${c.yellow("The key was rejected.")} V1 keys do not work on V2. Create a V2 key: ${KEYS_URL}`);
    }
    return false;
  }

  const sources = Array.isArray(payload) ? payload : [];
  console.log(`${c.green("✓")} HTTP ${response.status} in ${elapsed} ms — the key works`);
  if (sources.length) {
    console.log(`  ${c.dim(`First sources: ${sources.slice(0, 3).map((source) => source.name).join(", ")}`)}`);
  }
  return true;
}

function printNextSteps(opts, ok) {
  console.log(`\n${c.bold("Next steps")}`);
  console.log(`  1. Docs & API reference   ${c.cyan(DOCS_URL)}`);
  console.log(`  2. Install the SDK        ${c.dim("npm install @streamestate/sdk@beta")}`);
  if (opts.writeEnv) {
    console.log(`  3. Load your key          ${c.dim(`process.env.${ENV_VAR}`)} (from ${opts.envFile})`);
  }
  console.log(`\n${c.bold("Use it from Claude Code")}`);
  console.log(`  ${c.dim(MCP_LINE)}`);
  if (!ok) {
    console.log(
      `\n${c.yellow("Setup finished, but the test request did not succeed.")} Fix the key and re-run.`
    );
  }
  console.log("");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  console.log(`${c.bold("Stream Estate")} ${c.dim("· setup")}\n`);

  const { key, source } = await resolveKey(opts);
  console.log(`${c.green("✓")} API key from ${source} (${maskKey(key)})`);

  if (opts.writeEnv) {
    await writeEnvFile(opts, key);
  }

  const ok = opts.test ? await testRequest(key) : true;
  printNextSteps(opts, ok);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(c.red("Unexpected error:"), err?.message ?? err);
  process.exit(1);
});
