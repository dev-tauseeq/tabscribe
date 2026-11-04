// npm run setup: installs whisper.cpp, downloads the Whisper models and registers the
// helper with Chrome so the extension can reach it. Safe to run again at any time.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, open, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CONFIG_FILE,
  HELPER_DIR,
  HELPER_NAME,
  LAUNCHER_FILE,
  MODELS_DIR,
  STORE_EXTENSION_ID,
  SUPPORT_DIR,
} from './paths.mjs';

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const HELPER_FILES = ['host.mjs', 'paths.mjs'];
const DIST_DIR = resolve(SOURCE_DIR, '..', 'dist');
const DEFAULT_MODEL = 'large-v3-turbo-q5_0';
const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
const VAD_MODEL = 'ggml-silero-v5.1.2.bin';
const VAD_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL}`;
const EXTENSION_ID = /^[a-p]{32}$/;
const BROWSERS = [
  ['Google Chrome', 'Google/Chrome'],
  ['Google Chrome Beta', 'Google/Chrome Beta'],
  ['Google Chrome Dev', 'Google/Chrome Dev'],
  ['Google Chrome Canary', 'Google/Chrome Canary'],
  ['Chromium', 'Chromium'],
  ['Microsoft Edge', 'Microsoft Edge'],
  ['Brave', 'BraveSoftware/Brave-Browser'],
].map(([name, folder]) => ({ name, dir: join(homedir(), 'Library', 'Application Support', folder) }));

const { values: options } = parseArgs({
  options: {
    'extension-id': { type: 'string', multiple: true },
    model: { type: 'string', default: DEFAULT_MODEL },
  },
});

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function heading(text) {
  console.log(`\n== ${text}`);
}

function which(command) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

async function download(url, target) {
  if (existsSync(target)) {
    console.log(`Already downloaded: ${target}`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) fail(`Download failed (${response.status}): ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const partial = `${target}.part`;
  const file = await open(partial, 'w');
  let received = 0;
  let shown = -1;
  for await (const chunk of response.body) {
    await file.write(chunk);
    received += chunk.length;
    const percent = total ? Math.floor((received / total) * 100) : -1;
    if (percent !== shown && process.stdout.isTTY) {
      shown = percent;
      process.stdout.write(`\r  ${percent}% of ${Math.round(total / 1e6)} MB`);
    }
  }
  await file.close();
  if (process.stdout.isTTY) process.stdout.write('\n');
  await rename(partial, target);
  console.log(`Saved ${target}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

// Unpacked extensions get their ID from the folder they were loaded from, so look it up.
function findExtensionIds(browser) {
  const ids = new Set();
  let profiles = [];
  try {
    profiles = readdirSync(browser.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return ids;
  }
  for (const profile of profiles) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      const settings = readJson(join(browser.dir, profile.name, file))?.extensions?.settings ?? {};
      for (const [id, info] of Object.entries(settings)) {
        if (info?.path && resolve(info.path) === DIST_DIR) ids.add(id);
      }
    }
  }
  return ids;
}

const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

if (process.platform !== 'darwin') fail('The Meeting Recorder helper runs on macOS only.');

heading('Claude Code');
const claude = which('claude');
if (claude) {
  const version = spawnSync(claude, ['--version'], { encoding: 'utf8' });
  console.log(`Found ${claude} (${version.stdout?.trim() || 'version unknown'})`);
  console.log('Summaries use the account you are signed in to in Claude Code. Run `claude` once to sign in if needed.');
} else {
  console.log('Claude Code (claude) was not found. Install it from https://claude.com/claude-code,');
  console.log('sign in by running `claude`, then run npm run setup again. Recording still works without it.');
}

heading('Whisper');
let whisper = which('whisper-cli');
if (!whisper) {
  const brew = which('brew');
  if (!brew) fail('whisper.cpp is missing. Install Homebrew from https://brew.sh, then run npm run setup again.');
  console.log('Installing whisper.cpp with Homebrew...');
  if (spawnSync(brew, ['install', 'whisper-cpp'], { stdio: 'inherit' }).status !== 0) {
    fail('brew install whisper-cpp failed. Fix the error above, then run npm run setup again.');
  }
  whisper = which('whisper-cli') ?? fail('whisper-cli is still missing after the install.');
}
console.log(`Found ${whisper}`);

const modelName = options.model;
const model = join(MODELS_DIR, `ggml-${modelName}.bin`);
const vadModel = join(MODELS_DIR, VAD_MODEL);
await download(MODEL_URL(modelName), model);
await download(VAD_URL, vadModel);

heading('Chrome');
for (const id of options['extension-id'] ?? []) {
  if (!EXTENSION_ID.test(id)) fail(`"${id}" is not an extension ID. Copy it from the extension's Settings page.`);
}
// IDs given on the command line and the Web Store ID work in every installed browser.
const everywhere = [...(options['extension-id'] ?? []), ...(STORE_EXTENSION_ID ? [STORE_EXTENSION_ID] : [])];
const found = BROWSERS.filter((browser) => existsSync(browser.dir))
  .map((browser) => ({ ...browser, ids: new Set([...everywhere, ...findExtensionIds(browser)]) }))
  .filter((browser) => browser.ids.size > 0);
if (found.length === 0) {
  fail(
    [
      `Meeting Recorder was not found in Chrome. Run npm run build, open chrome://extensions,`,
      `turn on Developer mode, click Load unpacked and choose ${DIST_DIR}. Then run npm run setup again.`,
      'If it is loaded from another folder, run: npm run setup -- --extension-id <ID from the Settings page>',
    ].join('\n'),
  );
}

// The helper runs from its own copy, so moving or deleting this folder does not break it.
await mkdir(HELPER_DIR, { recursive: true });
for (const file of HELPER_FILES) await copyFile(join(SOURCE_DIR, file), join(HELPER_DIR, file));
await writeFile(CONFIG_FILE, `${JSON.stringify({ claude, whisper, model, modelName, vadModel }, null, 2)}\n`);
await writeFile(
  LAUNCHER_FILE,
  [
    '#!/bin/sh',
    '# Created by npm run setup in the meeting-recorder folder. Chrome starts this to reach the helper.',
    `export PATH=${shellQuote(process.env.PATH ?? '/usr/bin:/bin')}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(join(HELPER_DIR, 'host.mjs'))}`,
    '',
  ].join('\n'),
);
await chmod(LAUNCHER_FILE, 0o755);

for (const browser of found) {
  const manifestDir = join(browser.dir, 'NativeMessagingHosts');
  await mkdir(manifestDir, { recursive: true });
  await access(manifestDir, constants.W_OK);
  const manifest = {
    name: HELPER_NAME,
    description: 'Meeting Recorder helper',
    path: LAUNCHER_FILE,
    type: 'stdio',
    allowed_origins: [...browser.ids].map((id) => `chrome-extension://${id}/`),
  };
  const manifestFile = join(manifestDir, `${HELPER_NAME}.json`);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${browser.name}: registered for extension ${[...browser.ids].join(', ')}`);
}

heading('Done');
console.log('Reload Meeting Recorder on chrome://extensions, then open its Settings page to check the helper.');
