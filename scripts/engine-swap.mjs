#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PROJECTS_ROOT = path.resolve(REPO_ROOT, '..');
const LOCAL_SERVER_PATH = path.join(REPO_ROOT, 'sdk', 'server.mjs');

const [, , command, ...projectNames] = process.argv;

if (!command || ![ 'use-local', 'use-prod', 'status' ].includes(command)) {
  printUsageAndExit(1);
}

if (projectNames.length === 0) {
  printUsageAndExit(1);
}

for (const projectName of projectNames) {
  const packageDir = path.join(PROJECTS_ROOT, projectName, 'node_modules', 'hytopia');
  const installedServerPath = path.join(packageDir, 'server.mjs');
  const prodBackupPath = path.join(packageDir, 'server.mjs.prod');

  if (!fs.existsSync(packageDir)) {
    fail(`Project "${projectName}" does not contain ${packageDir}`);
  }

  if (command === 'use-local') {
    ensureProdBackup(installedServerPath, prodBackupPath);
    replaceWithSymlink(installedServerPath, LOCAL_SERVER_PATH);
    console.log(`[use-local] ${projectName} -> ${LOCAL_SERVER_PATH}`);
    continue;
  }

  if (command === 'use-prod') {
    if (!fs.existsSync(prodBackupPath)) {
      fail(`Project "${projectName}" has no prod backup at ${prodBackupPath}`);
    }

    removeIfExists(installedServerPath);
    fs.copyFileSync(prodBackupPath, installedServerPath);
    console.log(`[use-prod]  ${projectName} -> ${prodBackupPath}`);
    continue;
  }

  console.log(`[status]    ${projectName} -> ${detectStatus(installedServerPath, prodBackupPath)}`);
}

function detectStatus(installedServerPath, prodBackupPath) {
  try {
    const stat = fs.lstatSync(installedServerPath);
    const backupSuffix = fs.existsSync(prodBackupPath) ? '' : ' (no prod backup)';

    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(installedServerPath), fs.readlinkSync(installedServerPath));
      if (target === LOCAL_SERVER_PATH) {
        return `local build (symlink)${backupSuffix}`;
      }

      return `custom symlink -> ${target}`;
    }

    if (fs.existsSync(prodBackupPath) && sameFileContents(installedServerPath, prodBackupPath)) {
      return 'prod backup';
    }

    if (sameFileContents(installedServerPath, LOCAL_SERVER_PATH)) {
      return `local build (copied file)${backupSuffix}`;
    }

    return `custom file${backupSuffix}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function ensureProdBackup(installedServerPath, prodBackupPath) {
  if (fs.existsSync(prodBackupPath)) {
    return;
  }

  if (!fs.existsSync(installedServerPath)) {
    fail(`Cannot create prod backup because ${installedServerPath} does not exist`);
  }

  const installedStat = fs.lstatSync(installedServerPath);
  if (installedStat.isSymbolicLink()) {
    fail(`Refusing to create prod backup from symlinked file ${installedServerPath}`);
  }

  if (sameFileContents(installedServerPath, LOCAL_SERVER_PATH)) {
    fail(`Refusing to create prod backup from ${installedServerPath} because it already matches the local build. Restore the real prod file first.`);
  }

  fs.copyFileSync(installedServerPath, prodBackupPath);
}

function replaceWithSymlink(installedServerPath, targetPath) {
  removeIfExists(installedServerPath);

  const relativeTarget = path.relative(path.dirname(installedServerPath), targetPath);
  fs.symlinkSync(relativeTarget, installedServerPath);
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function sameFileContents(a, b) {
  const first = fs.readFileSync(a);
  const second = fs.readFileSync(b);
  return first.equals(second);
}

function isMissingFileError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function printUsageAndExit(code) {
  console.error('Usage: node scripts/engine-swap.mjs <use-local|use-prod|status> <project...>');
  process.exit(code);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
