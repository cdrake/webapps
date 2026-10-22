// Downloads the pinned N4 reference (validation/reference.json) into a folder and checks each
// file's size and SHA-256; a verified file is not downloaded again. Prints N4_REFERENCE=<folder>
// for `>> "$GITHUB_ENV"`.
//
//   node validation/fetch-reference.mjs <folder>
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const manifest = JSON.parse(await readFile(new URL("./reference.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// An immutable address only: the dataset at one full commit.
if (!/^https:\/\/huggingface\.co\/datasets\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//.test(manifest.base)) {
  throw new Error(`reference.json: ${manifest.base} is not a Hugging Face commit URL`);
}

async function verified(path, file) {
  try {
    const bytes = await readFile(path);
    return bytes.length === file.bytes && sha256(bytes) === file.sha256;
  } catch {
    return false;
  }
}

const folder = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node validation/fetch-reference.mjs <folder>");
await mkdir(folder, { recursive: true });
for (const file of manifest.files) {
  const path = join(folder, file.name);
  if (await verified(path, file)) continue;
  const response = await fetch(manifest.base + file.name);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`${file.name}: size or SHA-256 does not match reference.json`);
  await writeFile(path, bytes);
}
console.log(`N4_REFERENCE=${folder}`);
