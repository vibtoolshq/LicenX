import * as archiverModule from "archiver";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkDirectory = path.join(projectRoot, "SDK", "client", "python", "licenx");
const configTemplate = path.join(projectRoot, "SDK", "client", "python", "licenx.config.py");
const publicDirectory = path.join(projectRoot, "public");
const archivePath = path.join(publicDirectory, "licenx-python-sdk.zip");
const tempArchivePath = archivePath + "." + process.pid + ".tmp";
const fixedArchiveDate = new Date("2000-01-01T00:00:00.000Z");
const excludedDirs = new Set(["__pycache__", "licenx.egg-info", "test", "SDK feature", ".git"]);
const excludedFiles = new Set([".DS_Store"]);

async function collectFiles(directory, relative = "") {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    if (excludedFiles.has(entry.name) || excludedDirs.has(entry.name) ||
        entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue; // refuse symlinks
    const archiveName = [relative, entry.name].filter(Boolean).join("/");
    const srcPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(srcPath, archiveName));
    else files.push({ srcPath, archiveName });
  }
  return files;
}
async function buildArchive() {
  if (!fs.existsSync(sdkDirectory) || !fs.existsSync(configTemplate))
    throw new Error("Primary licenx package and literal config template are required");
  const files = await collectFiles(sdkDirectory);
  for (const file of ["pyproject.toml", "__init__.py", "config.py"]) {
    if (!files.some(entry => entry.archiveName === file))
      throw new Error("Primary package incomplete: " + file);
  }
  await fs.promises.mkdir(publicDirectory, { recursive: true });
  const ZipClass = archiverModule.ZipArchive || archiverModule.default || archiverModule;
  const archive = typeof ZipClass === "function" && ZipClass.prototype?.file
    ? new ZipClass({ zlib: { level: 9 } })
    : ZipClass("zip", { zlib: { level: 9 } });
  const output = fs.createWriteStream(tempArchivePath);
  const outputFinished = finished(output);
  archive.on("error", error => output.destroy(error));
  archive.pipe(output);
  for (const item of files) {
    archive.append(await fs.promises.readFile(item.srcPath),
      { name: item.archiveName, date: fixedArchiveDate, mode: 0o644 });
  }
  archive.append(await fs.promises.readFile(configTemplate),
    { name: "licenx.config.py", date: fixedArchiveDate, mode: 0o644 });
  try {
    await archive.finalize();
    await outputFinished;
    await fs.promises.rename(tempArchivePath, archivePath);
  } catch (error) {
    await fs.promises.rm(tempArchivePath, { force: true });
    throw error;
  }
  console.log("Generated primary pip-installable licenx source kit (" + (files.length + 1) + " files).");
}
buildArchive().catch(error => {
  console.error("SDK packaging failed: " + error.message);
  process.exitCode = 1;
});
