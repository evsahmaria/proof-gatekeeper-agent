import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";

/**
 * Download official gatekeeper circuit artifacts.
 * URLs come from https://agentgames.zkverify.io/api/circuit-info
 * (network: mainnet). Files are large; they are git-ignored by default.
 */
const jobs = [
  { url: config.circuitWasmUrl, dest: config.circuitWasmPath },
  { url: config.circuitZkeyUrl, dest: config.circuitZkeyPath },
];

for (const { url, dest } of jobs) {
  console.log(`Downloading ${url} -> ${dest}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAILED: HTTP ${res.status} for ${url}`);
    process.exitCode = 1;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`OK: ${dest} (${buf.length} bytes)`);
}
console.log("Done. Next: fill circuits/inputs.json from the dashboard starter prompt (see README).");
