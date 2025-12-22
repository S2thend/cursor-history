#!/usr/bin/env node
/**
 * Debug script to test Cursor data reading
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

const basePath = join(homedir(), 'Library/Application Support/Cursor/User/workspaceStorage');

console.log('Base path:', basePath);
console.log('Exists:', existsSync(basePath));

if (!existsSync(basePath)) {
  console.log('Base path does not exist!');
  process.exit(1);
}

const entries = readdirSync(basePath, { withFileTypes: true });
console.log('\nFound', entries.length, 'entries\n');

for (const entry of entries.slice(0, 3)) {
  if (!entry.isDirectory()) continue;

  console.log('=== Workspace:', entry.name, '===');

  const workspaceDir = join(basePath, entry.name);
  const dbPath = join(workspaceDir, 'state.vscdb');
  const wsJsonPath = join(workspaceDir, 'workspace.json');

  // Check workspace.json
  if (existsSync(wsJsonPath)) {
    const content = readFileSync(wsJsonPath, 'utf-8');
    console.log('workspace.json:', content);
    try {
      const data = JSON.parse(content);
      const folderPath = data.folder?.replace(/^file:\/\//, '').replace(/%20/g, ' ');
      console.log('Parsed folder path:', folderPath);
    } catch (e) {
      console.log('Failed to parse workspace.json:', e.message);
    }
  } else {
    console.log('workspace.json: NOT FOUND');
  }

  // Check database
  if (existsSync(dbPath)) {
    console.log('state.vscdb: EXISTS');
    try {
      const db = new Database(dbPath, { readonly: true });

      // Check for composer.composerData
      const composerRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      if (composerRow) {
        console.log('composer.composerData: FOUND');
        const data = JSON.parse(composerRow.value);
        console.log('  allComposers count:', data.allComposers?.length ?? 0);
        if (data.allComposers?.length > 0) {
          console.log('  First composer:', JSON.stringify(data.allComposers[0], null, 2));
        }
      } else {
        console.log('composer.composerData: NOT FOUND');
      }

      // Check legacy keys
      const legacyRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'").get();
      console.log('legacy chatdata:', legacyRow ? 'FOUND' : 'NOT FOUND');

      db.close();
    } catch (e) {
      console.log('Database error:', e.message);
    }
  } else {
    console.log('state.vscdb: NOT FOUND');
  }

  console.log('');
}
