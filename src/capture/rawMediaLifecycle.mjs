import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

const rawMediaDirectories = ["raw-media"];
const rawMediaExtensions = new Set([
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

export function applyRawMediaLifecycle(options = {}) {
  const root = options.root ?? process.cwd();
  const day = validateDay(options.day);
  const deleteRawMedia = Boolean(options.deleteRawMedia);
  const capturesDayDir = path.resolve(root, "storage", "captures", day);

  const mediaFiles = collectRawMediaFiles(capturesDayDir);

  if (deleteRawMedia) {
    for (const filePath of mediaFiles) {
      unlinkSync(filePath);
    }
  }

  return {
    schemaVersion: "raw-media-lifecycle.v1",
    day,
    debugRetentionExplicitlyEnabled: false,
    action: deleteRawMedia ? "deleted_after_analysis" : "retained_by_default",
    rawMediaDirectories,
    mediaFilesObserved: mediaFiles.length,
    mediaFilesDeleted: deleteRawMedia ? mediaFiles.length : 0,
    mediaFilesRetained: deleteRawMedia ? 0 : mediaFiles.length,
    policy: "Day-scoped raw media files are retained by default and deleted only when --delete-raw-media is explicitly set."
  };
}

function collectRawMediaFiles(capturesDayDir) {
  const mediaFiles = [];

  for (const directoryName of rawMediaDirectories) {
    const directoryPath = path.join(capturesDayDir, directoryName);
    if (!existsSync(directoryPath)) continue;
    assertInside(capturesDayDir, directoryPath);
    const stat = lstatSync(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    collectFromDirectory(directoryPath, capturesDayDir, mediaFiles);
  }

  return mediaFiles;
}

function collectFromDirectory(directoryPath, capturesDayDir, mediaFiles) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    assertInside(capturesDayDir, entryPath);

    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) continue;

    if (stat.isDirectory()) {
      collectFromDirectory(entryPath, capturesDayDir, mediaFiles);
      continue;
    }

    if (stat.isFile() && rawMediaExtensions.has(path.extname(entry.name).toLowerCase())) {
      mediaFiles.push(entryPath);
    }
  }
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error("Refusing to process raw media outside the day-scoped capture directory.");
}

function validateDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error(`Invalid day "${day}". Expected YYYY-MM-DD.`);
  }
  return day;
}
