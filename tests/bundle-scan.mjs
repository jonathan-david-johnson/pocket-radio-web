// Builds the browser bundle into a temporary directory and fails if any file
// in it contains a database key, a Supabase reference, the user id header or a
// server secret. The browser must hold neither the anon key nor the user's id
// (web README, Security model). Run with pnpm run test:bundle.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import assert from "node:assert/strict";
import { build } from "vite";

const PATTERNS = [
  ["user id header", /x-user-uuid/i],
  ["user id field", /user_?uuid/i],
  ["service-role key name", /service[_-]?role/i],
  ["anon key name", /anon[_-]?key/i],
  ["Supabase reference", /supabase/i],
  ["PostgREST apikey header", /\bapikey\b/i],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Supabase API key", /\bsb_(publishable|secret)_/],
];

// Server secret values from the environment or an ignored .dev.vars. Their
// values are compared, never printed.
const SECRET_NAMES = ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "PC_CLIENT_ID", "PC_CLIENT_SECRET"];
async function secretValues() {
  const values = new Map();
  for (const name of SECRET_NAMES) if (process.env[name]) values.set(name, process.env[name]);
  try {
    for (const line of (await readFile(".dev.vars", "utf8")).split("\n")) {
      const match = /^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
      if (match && SECRET_NAMES.includes(match[1]) && match[2]) values.set(match[1], match[2]);
    }
  } catch { /* no .dev.vars */ }
  return [...values].filter(([, value]) => value.length >= 8);
}

function findLeaks(text, secrets) {
  return [
    ...PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    ...secrets.filter(([, value]) => text.includes(value)).map(([name]) => `value of ${name}`),
  ];
}

// The scan must be able to fail: each pattern and secret is detected in a sample.
for (const [name, sample] of [
  ["user id header", "headers['x-user-uuid']"], ["user id field", "row.userUuid"],
  ["service-role key name", "SERVICE_ROLE"], ["anon key name", "anonKey"],
  ["Supabase reference", "https://abc.supabase.co"], ["PostgREST apikey header", "{apikey: k}"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9"], ["Supabase API key", "sb_publishable_abc"],
]) assert.ok(findLeaks(sample, []).includes(name), `scan misses: ${name}`);
assert.deepEqual(findLeaks("x fixture-secret-value y", [["S", "fixture-secret-value"]]), ["value of S"]);

const outDir = await mkdtemp(join(tmpdir(), "pr-bundle-scan-"));
try {
  await build({ logLevel: "warn", build: { outDir, emptyOutDir: true } });
  const secrets = await secretValues();
  const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  assert.ok(files.some(file => file.endsWith(".js")), "the build produced no JavaScript");
  const leaks = [];
  for (const file of files) {
    for (const leak of findLeaks(await readFile(file, "latin1"), secrets)) leaks.push(`${relative(outDir, file)}: ${leak}`);
  }
  assert.deepEqual(leaks, [], `The browser bundle contains server-only material:\n${leaks.join("\n")}`);
  console.log(`Browser bundle: ${files.length} files contain no database keys, Supabase references, user id or server secrets (${secrets.length} secret values compared).`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
