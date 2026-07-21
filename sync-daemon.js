#!/usr/bin/env node
/**
 * Copyright 2026 Thanh Tran
 * Licensed under the Apache License, Version 2.0 (see LICENSE file).
 *
 * Two-way sync daemon between n8n-as-code .workflow.ts files and standalone
 * Code node .js/.py files.
 *
 *  - .workflow.ts changes (e.g. after using n8n-as-code's Pull, or a new node
 *    added) -> the affected Code node(s) are (re-)extracted into local files
 *    automatically. New nodes get a new file; changed code updates the file.
 *  - Local .js/.py file changes (you editing it) -> written back into the
 *    matching .workflow.ts node and pushed via `n8nac push`.
 *
 * A content-diff cache prevents the two directions from looping each other.
 *
 * Usage:
 *   node sync-daemon.js "workflows/**\/*.workflow.ts" .n8n-code
 *
 * Env vars:
 *   N8NAC_AUTO_PUSH=false        disable auto-push, only sync into .workflow.ts
 *   N8NAC_PUSH_CMD="npx n8nac push"   override the push command
 */
import { Project, SyntaxKind } from "ts-morph";
import { globSync } from "glob";
import chokidar from "chokidar";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const WORKFLOWS_GLOB = process.argv[2] || "workflows/**/*.workflow.ts";
const OUT_DIR = path.resolve(process.argv[3] || ".n8n-code");
const PUSH_CMD = process.env.N8NAC_PUSH_CMD || "npx n8nac push";
const AUTO_PUSH = process.env.N8NAC_AUTO_PUSH !== "false";

let allWorkflowFiles = [];

const project = new Project({ skipAddingFilesFromTsConfig: true });

/** absOutFile -> { workflowFile, nodeName, fieldName } */
let manifest = {};
/** absOutFile -> last content we know about, from either direction */
const lastKnownContent = new Map();
const pushTimers = new Map();
/** workflowId -> absolute .workflow.ts path, refreshed on every extract */
const idToWorkflowFile = new Map();

function sanitizeFileName(name) {
  // Only strip characters that are genuinely invalid in file/folder names
  // (illegal on Windows, and troublesome on macOS/Linux too), plus control
  // characters. Everything else -- spaces, hyphens, parentheses, accents --
  // is kept as-is for readability, since every path is already quoted
  // wherever it's passed to a shell command.
  return String(name)
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "_") // invalid path chars + control chars
    .replace(/\s+/g, " ") // collapse runs of whitespace to a single space
    .trim();
}

function getLiteralText(node) {
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getLiteralText();
  }
  return null; // dynamic expression -> not safe to extract
}

function escapeForTemplateLiteral(code) {
  return code.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function saveManifest() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Circuit breaker: if a file gets re-triggered too many times too fast,
 * something is wrong (unexpected loop) -- stop touching it and warn loudly,
 * rather than spinning forever. */
const triggerHistory = new Map(); // absPath -> timestamps[]
const loopBroken = new Set();

function tripsLoopGuard(absPath, { thresholdCount = 6, windowMs = 3000 } = {}) {
  if (loopBroken.has(absPath)) return true;
  const now = Date.now();
  const history = (triggerHistory.get(absPath) || []).filter((t) => now - t < windowMs);
  history.push(now);
  triggerHistory.set(absPath, history);
  if (history.length > thresholdCount) {
    loopBroken.add(absPath);
    console.error(
      `\n  [loop-guard] "${path.relative(process.cwd(), absPath)}" changed ${history.length}x in ${windowMs}ms.\n` +
        `  Stopping auto-sync for this file to avoid a runaway loop. Restart the daemon after checking what's writing to it.\n`
    );
    return true;
  }
  return false;
}

/**
 * Scan one .workflow.ts file's Code nodes and make sure each has an
 * up-to-date local file. Writes a file when it's new, or when the workflow's
 * code differs from what we last knew (i.e. the change came from the
 * workflow side, e.g. a Pull -- not an echo of a local edit we just wrote).
 */
function extractFromWorkflowFile(absWorkflowFile, { logPulls } = {}) {
  const sourceFile = project.getSourceFile(absWorkflowFile) || project.addSourceFileAtPath(absWorkflowFile);
  sourceFile.refreshFromFileSystemSync();

  const meta = getWorkflowMeta(sourceFile);
  if (meta?.id) idToWorkflowFile.set(meta.id, absWorkflowFile);
  const outSubDir = resolveOutSubDir(absWorkflowFile, meta);

  for (const cls of sourceFile.getClasses()) {
    for (const prop of cls.getProperties()) {
      const nodeDecorator = prop.getDecorator("node");
      if (!nodeDecorator) continue;

      const decoratorObj = nodeDecorator.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
      if (!decoratorObj) continue;

      const typeProp = decoratorObj.getProperty("type");
      const typeValue = typeProp?.getFirstDescendantByKind(SyntaxKind.StringLiteral)?.getLiteralText();
      if (typeValue !== "n8n-nodes-base.code") continue;

      const displayNameProp = decoratorObj.getProperty("name");
      const displayName = displayNameProp?.getFirstDescendantByKind(SyntaxKind.StringLiteral)?.getLiteralText();

      const paramsObj = prop.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
      if (!paramsObj) continue;

      const codeField = paramsObj.getProperty("jsCode") || paramsObj.getProperty("pythonCode");
      if (!codeField) continue;

      const fieldName = codeField.getName();
      const isPython = fieldName === "pythonCode";
      const codeInitializer = codeField.getInitializer();
      if (!codeInitializer) continue;

      const codeText = getLiteralText(codeInitializer);
      if (codeText === null) continue;

      const nodeName = prop.getName();
      const fileBase = sanitizeFileName(displayName || nodeName);
      const ext = isPython ? "py" : "js";
      const absOutFile = path.resolve(path.join(outSubDir, `${fileBase}.${ext}`));

      manifest[absOutFile] = { workflowFile: absWorkflowFile, nodeName, fieldName };

      const existing = fs.existsSync(absOutFile) ? fs.readFileSync(absOutFile, "utf8") : null;
      const cached = lastKnownContent.get(absOutFile);

      if (existing === null) {
        fs.mkdirSync(outSubDir, { recursive: true });
        fs.writeFileSync(absOutFile, codeText, "utf8");
        lastKnownContent.set(absOutFile, codeText);
        console.log(`  [pull] New Code node "${nodeName}" -> ${path.relative(process.cwd(), absOutFile)}`);
      } else if (codeText !== existing && codeText !== cached) {
        fs.writeFileSync(absOutFile, codeText, "utf8");
        lastKnownContent.set(absOutFile, codeText);
        if (logPulls) {
          console.log(
            `  [pull] Updated "${nodeName}" from workflow -> ${path.relative(process.cwd(), absOutFile)}`
          );
        }
      } else {
        lastKnownContent.set(absOutFile, existing);
      }
    }
  }
}

function initialExtractAll() {
  const files = globSync(WORKFLOWS_GLOB);
  if (files.length === 0) {
    console.error(`No files matched: ${WORKFLOWS_GLOB}`);
    process.exit(1);
  }
  for (const f of files) {
    extractFromWorkflowFile(path.resolve(f), { logPulls: false });
  }
  saveManifest();
  console.log(
    `Initial extract: ${Object.keys(manifest).length} Code node script(s) under ${path.relative(
      process.cwd(),
      OUT_DIR
    )}/`
  );
  allWorkflowFiles = files.map((f) => path.resolve(f));
  return allWorkflowFiles;
}

function getWorkflowMeta(sourceFile) {
  for (const cls of sourceFile.getClasses()) {
    const decorator = cls.getDecorator("workflow");
    if (!decorator) continue;
    const obj = decorator.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!obj) continue;
    const idProp = obj.getProperty("id");
    const nameProp = obj.getProperty("name");
    const id = idProp?.getFirstDescendantByKind(SyntaxKind.StringLiteral)?.getLiteralText();
    const name = nameProp?.getFirstDescendantByKind(SyntaxKind.StringLiteral)?.getLiteralText();
    if (id) return { id, name };
  }
  return null;
}

/** Folder = "<workflowId>__<currentName>". The id prefix guarantees no
 * collisions and lets us find the right folder regardless of its suffix. If
 * the existing folder's suffix no longer matches the workflow's current
 * display name (e.g. right after a Pull that picked up a rename on n8n),
 * it's renamed on disk immediately -- safe even while the daemon is running,
 * since the code-file watcher is glob-based and recovers via add/unlink. */
function resolveOutSubDir(absWorkflowFile, meta) {
  if (!meta?.id) {
    return path.join(OUT_DIR, path.basename(absWorkflowFile).replace(/\.workflow\.ts$/, ""));
  }

  const prefix = `${meta.id}__`;
  const desiredSuffix = sanitizeFileName(meta.name || path.basename(absWorkflowFile).replace(/\.workflow\.ts$/, ""));
  const desiredFolderName = `${prefix}${desiredSuffix}`;

  let existing = null;
  if (fs.existsSync(OUT_DIR)) {
    existing = fs
      .readdirSync(OUT_DIR)
      .find((name) => name.startsWith(prefix) && fs.statSync(path.join(OUT_DIR, name)).isDirectory());
  }

  if (!existing) {
    return path.join(OUT_DIR, desiredFolderName);
  }

  if (existing !== desiredFolderName) {
    const oldPath = path.join(OUT_DIR, existing);
    const newPath = path.join(OUT_DIR, desiredFolderName);
    if (!fs.existsSync(newPath)) {
      fs.renameSync(oldPath, newPath);
      console.log(`  [rename] "${existing}" -> "${desiredFolderName}" (workflow name changed)`);
      return newPath;
    }
    console.warn(`  [rename] Wanted to rename "${existing}" -> "${desiredFolderName}" but target already exists — leaving as-is.`);
  }

  return path.join(OUT_DIR, existing);
}

function schedulePush(workflowFile) {
  if (!AUTO_PUSH) return;
  if (pushTimers.has(workflowFile)) clearTimeout(pushTimers.get(workflowFile));
  const timer = setTimeout(() => {
    try {
      console.log(`Pushing ${path.relative(process.cwd(), workflowFile)} ...`);
      execSync(`${PUSH_CMD} "${workflowFile}"`, { stdio: "inherit" });
    } catch (err) {
      console.error(`Push failed: ${err.message}`);
    }
    pushTimers.delete(workflowFile);
  }, 800);
  pushTimers.set(workflowFile, timer);
}

function handleLocalEdit(absFilePath) {
  if (tripsLoopGuard(absFilePath)) return;

  const entry = manifest[absFilePath];
  if (!entry) {
    console.warn(`No manifest entry for ${absFilePath} — was it added after the daemon started?`);
    return;
  }

  const newCode = fs.readFileSync(absFilePath, "utf8");
  if (newCode === lastKnownContent.get(absFilePath)) return; // nothing actually changed (e.g. our own pull write)

  const { workflowFile, nodeName, fieldName } = entry;
  const sourceFile = project.getSourceFile(workflowFile) || project.addSourceFileAtPath(workflowFile);
  sourceFile.refreshFromFileSystemSync();

  let updated = false;
  for (const cls of sourceFile.getClasses()) {
    for (const prop of cls.getProperties()) {
      if (prop.getName() !== nodeName || !prop.getDecorator("node")) continue;
      const paramsObj = prop.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
      const codeField = paramsObj?.getProperty(fieldName);
      if (!codeField) continue;
      codeField.setInitializer("`" + escapeForTemplateLiteral(newCode) + "`");
      updated = true;
    }
  }

  if (updated) {
    sourceFile.saveSync();
    lastKnownContent.set(absFilePath, newCode);
    console.log(`Synced "${nodeName}" -> ${path.relative(process.cwd(), workflowFile)}`);
    schedulePush(workflowFile);
  } else {
    console.warn(`Could not find node "${nodeName}" in ${workflowFile} — structure may have changed.`);
  }
}

function handleWorkflowFileChange(absWorkflowFile) {
  if (tripsLoopGuard(absWorkflowFile)) return;

  extractFromWorkflowFile(absWorkflowFile, { logPulls: true });
  saveManifest();
}

function handleCodeFileAdd(absFilePath) {
  if (manifest[absFilePath]) return; // already known -- e.g. our own write during extraction

  const folderName = path.basename(path.dirname(absFilePath));
  const id = folderName.split("__")[0];
  const workflowFile = idToWorkflowFile.get(id);

  if (!workflowFile) {
    console.warn(
      `  [watch] New file ${path.relative(process.cwd(), absFilePath)} doesn't match a known workflow id — ignoring.`
    );
    return;
  }

  console.log(
    `  [watch] Detected file under "${folderName}" not in the manifest (renamed folder?) — rebuilding mapping...`
  );
  extractFromWorkflowFile(workflowFile, { logPulls: false });
  saveManifest();
}

function handleCodeFileUnlink(absFilePath) {
  if (manifest[absFilePath]) {
    delete manifest[absFilePath];
    lastKnownContent.delete(absFilePath);
    saveManifest();
  }
}

function main() {
  const workflowFiles = initialExtractAll();

  console.log(
    `\nWatching ${workflowFiles.length} workflow file(s) (for pulls) and ${
      Object.keys(manifest).length
    } code file(s) (for local edits)...`
  );
  console.log(AUTO_PUSH ? `Auto-push enabled: ${PUSH_CMD}` : `Auto-push disabled — syncing into .workflow.ts only`);

  // Glob over OUT_DIR/*/*.{js,py} instead of a fixed path list -- this way
  // renaming a folder's suffix (dev does this manually) is picked up as a
  // plain add/unlink pair instead of silently breaking the watch.
  const codeFileGlobs = [
    path.join(OUT_DIR, "*", "*.js").split(path.sep).join("/"),
    path.join(OUT_DIR, "*", "*.py").split(path.sep).join("/"),
  ];

  chokidar
    .watch(codeFileGlobs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    .on("change", handleLocalEdit)
    .on("add", handleCodeFileAdd)
    .on("unlink", handleCodeFileUnlink);

  // Any pull necessarily rewrites the .workflow.ts file on disk. Watching the
  // GLOB pattern directly (not a fixed file list) also catches the case where
  // n8n-as-code renames the underlying file itself -- the new file gets
  // picked up automatically and, thanks to resolveOutSubDir() keying by
  // workflow id, still lands in the same folder as before.
  chokidar
    .watch(WORKFLOWS_GLOB, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    .on("change", handleWorkflowFileChange)
    .on("add", handleWorkflowFileChange)
    .on("unlink", (p) => {
      console.warn(
        `  [workflow] File disappeared: ${path.relative(process.cwd(), p)} — ` +
          `if it was renamed, the new file will be picked up automatically.`
      );
    });
}

main();
