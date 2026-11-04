// Chrome starts this program through native messaging. It saves files outside Downloads,
// runs whisper.cpp for the transcript, runs Claude Code (`claude -p`) for the notes and
// prints the summary to PDF with the browser. Nothing may be printed to stdout except
// protocol messages.
import { spawn } from 'node:child_process';
import { constants, existsSync, rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, HELPER_VERSION } from './paths.mjs';

const INLINE_REPLY_CHARS = 100_000;
const PART_CHARS = 100_000;
const HEARTBEAT_MS = 15_000;
const MAX_COPIES = 99;
// Whisper gets at least an hour, and three times the length of the recording for long ones.
// The length is estimated from the MP3 size at the recorder's 48 kbps.
const WHISPER_MIN_TIMEOUT_MS = 60 * 60 * 1000;
const MP3_BYTES_PER_SECOND = 6000;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;
const STATUS_TIMEOUT_MS = 15_000;
const CHOOSE_TIMEOUT_MS = 10 * 60 * 1000;
const PDF_TIMEOUT_MS = 2 * 60 * 1000;
// How long a program gets to stop after SIGTERM before it is killed.
const KILL_GRACE_MS = 5000;
// Chrome kills the helper 2 seconds after it closes the connection.
const SHUTDOWN_GRACE_MS = 1000;
const NON_SPEECH = /^(\[[^\]]*\]|\([^)]*\))$/;
const BROWSERS = ['Google Chrome', 'Google Chrome Beta', 'Google Chrome Dev', 'Google Chrome Canary', 'Chromium'];
BROWSERS.push('Microsoft Edge', 'Microsoft Edge Beta', 'Brave Browser', 'Vivaldi', 'Opera');

const children = new Set();
const tempDirs = new Set();
let shuttingDown = false;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// Chrome rejects messages from the host larger than 1 MB, so big replies go out in parts.
function reply(id, body) {
  const text = JSON.stringify(body);
  if (text.length <= INLINE_REPLY_CHARS) {
    send({ id, type: 'reply', body });
    return;
  }
  for (let offset = 0; offset < text.length; offset += PART_CHARS) {
    send({ id, type: 'part', text: text.slice(offset, offset + PART_CHARS) });
  }
  send({ id, type: 'end' });
}

// Each message is a 4-byte little-endian length followed by that many bytes of JSON.
function readMessages(onMessage) {
  let chunks = [];
  let size = 0;
  let needed = -1;
  process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    for (;;) {
      if (needed < 0) {
        if (size < 4) return;
        const head = chunks[0].length >= 4 ? chunks[0] : Buffer.concat(chunks, size);
        needed = 4 + head.readUInt32LE(0);
      }
      if (size < needed) return;
      const joined = Buffer.concat(chunks, size);
      const text = joined.subarray(4, needed).toString('utf8');
      chunks = [joined.subarray(needed)];
      size -= needed;
      needed = -1;
      try {
        onMessage(JSON.parse(text));
      } catch (error) {
        console.error('Ignored a message that is not JSON:', describe(error));
      }
    }
  });
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function lastLines(text, count = 6) {
  return text.trim().split('\n').slice(-count).join('\n').trim();
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const existing = (path) => (typeof path === 'string' && path && existsSync(path) ? path : null);

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-recorder-'));
  tempDirs.add(dir);
  return dir;
}

async function removeTempDir(dir) {
  tempDirs.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

// Each program runs in its own process group, so stopping it also stops what it started.
function stopChild(child, signal = 'SIGTERM') {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function run(command, args, { input, cwd, env, timeoutMs, onStderr, keepStdout = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', keepStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
      // A program that ignores SIGTERM would otherwise keep this request waiting forever.
      killTimer = setTimeout(() => stopChild(child, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    const finished = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      children.delete(child);
      if (shuttingDown && children.size === 0) exitNow();
    };
    child.stdout?.setEncoding('utf8').on('data', (data) => {
      stdout += data;
    });
    child.stderr.setEncoding('utf8').on('data', (data) => {
      stderr = (stderr + data).slice(-20_000);
      onStderr?.(data);
    });
    child.on('error', (error) => {
      finished();
      reject(error);
    });
    child.on('close', (code, signal) => {
      finished();
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

// Chrome stops an idle extension worker, so long jobs send a message every few seconds.
// Empty messages only keep it awake; the popup shows the others.
async function withHeartbeat(progress, initial, task) {
  let latest = initial;
  progress(latest);
  const timer = setInterval(() => progress(latest), HEARTBEAT_MS);
  try {
    return await task((message) => {
      if (message === latest) return;
      latest = message;
      progress(latest);
    });
  } finally {
    clearInterval(timer);
  }
}

function expandHome(path) {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

async function existingDirectory(input) {
  const expanded = expandHome(String(input ?? '').trim());
  if (!isAbsolute(expanded)) throw new Error('Use a full folder path, such as /Users/you/Documents/Meetings.');
  const path = resolve(expanded);
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`The folder ${path} does not exist.`);
  try {
    await access(path, constants.W_OK);
  } catch {
    throw new Error(`Meeting Recorder cannot write to ${path}.`);
  }
  return path;
}

function safeName(input) {
  const name = String(input ?? '');
  if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) throw new Error(`"${name}" is not a valid name.`);
  return name;
}

async function status({ details }) {
  const config = await loadConfig();
  const claude = existing(config.claude);
  const whisper = existing(config.whisper);
  const model = existing(config.model);
  const result = {
    version: HELPER_VERSION,
    ready: Boolean(claude && whisper && model),
    claude,
    whisper,
    model,
    modelName: config.modelName ?? null,
  };
  if (details && claude) {
    const version = await run(claude, ['--version'], { timeoutMs: STATUS_TIMEOUT_MS }).catch(() => undefined);
    result.claudeVersion = version?.code === 0 ? version.stdout.trim() : null;
  }
  return result;
}

const CHOOSE_FOLDER_SCRIPT = [
  'on run argv',
  'activate',
  'set question to "Choose the folder where Meeting Recorder saves meetings"',
  'if (count of argv) > 0 then',
  'set chosen to choose folder with prompt question default location (POSIX file (item 1 of argv))',
  'else',
  'set chosen to choose folder with prompt question',
  'end if',
  'return POSIX path of chosen',
  'end run',
];

async function chooseFolder({ current }) {
  const start = await existingDirectory(current).catch(() => undefined);
  const args = CHOOSE_FOLDER_SCRIPT.flatMap((line) => ['-e', line]);
  if (start) args.push(start);
  const result = await run('/usr/bin/osascript', args, { timeoutMs: CHOOSE_TIMEOUT_MS });
  if (result.code !== 0) {
    if (/-128/.test(result.stderr)) return { path: null };
    throw new Error(`The folder picker failed: ${lastLines(result.stderr) || `exit code ${result.code}`}`);
  }
  const chosen = result.stdout.trim();
  return { path: chosen.length > 1 ? chosen.replace(/\/+$/, '') : chosen };
}

async function checkFolder({ path }) {
  return { path: await existingDirectory(path) };
}

async function claimFolder({ dir, name, claimed }) {
  const base = await existingDirectory(dir);
  const wanted = safeName(name);
  if (claimed) {
    await mkdir(join(base, wanted), { recursive: true });
    return { folder: wanted, path: join(base, wanted) };
  }
  for (let copy = 1; copy <= MAX_COPIES; copy += 1) {
    const folder = copy === 1 ? wanted : `${wanted} (${copy})`;
    try {
      await mkdir(join(base, folder));
      return { folder, path: join(base, folder) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`There are already ${MAX_COPIES} folders named "${wanted}".`);
}

async function writeFileChunk({ dir, folder, name, data, first, last }) {
  const target = join(await existingDirectory(dir), safeName(folder));
  const fileName = safeName(name);
  const partial = join(target, `.${fileName}.part`);
  const path = join(target, fileName);
  try {
    await writeFile(partial, Buffer.from(data, 'base64'), { flag: first ? 'w' : 'a' });
    if (last) await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { path };
}

async function fileExists({ path }) {
  const info = await stat(String(path ?? '')).catch(() => null);
  return { exists: Boolean(info?.isFile()) };
}

async function transcribe({ audioPath }, progress) {
  const config = await loadConfig();
  const whisper = existing(config.whisper);
  const model = existing(config.model);
  if (!whisper || !model) throw new Error('Whisper is not set up. Run npm run setup in the meeting-recorder folder.');
  const audio = isAbsolute(String(audioPath)) ? await stat(audioPath).catch(() => null) : null;
  if (!audio?.isFile()) throw new Error(`The recording was not found at ${audioPath}. It may have been moved or deleted.`);
  const timeoutMs = Math.max(WHISPER_MIN_TIMEOUT_MS, (audio.size / MP3_BYTES_PER_SECOND) * 3 * 1000);

  const work = await makeTempDir();
  try {
    const output = join(work, 'transcript');
    const args = ['-m', model, '-f', audioPath, '-l', 'auto', '-oj', '-of', output, '-pp'];
    args.push('-t', String(Math.min(8, availableParallelism())));
    const vad = existing(config.vadModel);
    if (vad) args.push('--vad', '-vm', vad);

    const result = await withHeartbeat(progress, '', (update) =>
      run(whisper, args, {
        cwd: work,
        keepStdout: false,
        timeoutMs,
        onStderr: (text) => {
          const percent = [...text.matchAll(/progress\s*=\s*(\d+)%/g)].at(-1)?.[1];
          if (percent) update(`${percent}%`);
        },
      }),
    );
    if (result.timedOut) throw new Error(`Whisper did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
    if (result.code !== 0) throw new Error(`Whisper failed: ${lastLines(result.stderr) || `exit code ${result.code}`}`);

    const data = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    const segments = (data.transcription ?? [])
      .map((item) => ({ start: item.offsets?.from ?? 0, end: item.offsets?.to ?? 0, text: String(item.text ?? '').trim() }))
      .filter((segment) => segment.text && !NON_SPEECH.test(segment.text));
    return { language: data.result?.language ?? '', model: config.modelName ?? '', segments };
  } finally {
    await removeTempDir(work);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function askClaude({ model, system, prompt }, progress) {
  const config = await loadConfig();
  const claude = existing(config.claude);
  if (!claude) throw new Error('Claude Code was not found. Run npm run setup in the meeting-recorder folder.');

  // No tools, MCP servers or slash commands: the transcript is only text to read.
  const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
  args.push('--disable-slash-commands', '--system-prompt', String(system ?? ''));
  if (model) args.push('--model', String(model));
  // Claude Code reads its sign-in from the macOS Keychain, which needs USER.
  const { username } = userInfo();
  const env = { ...process.env, HOME: process.env.HOME || homedir(), USER: process.env.USER || username };
  env.LOGNAME ||= env.USER;
  delete env.CLAUDECODE;

  const result = await withHeartbeat(progress, '', () =>
    run(claude, args, { input: String(prompt ?? ''), cwd: tmpdir(), env, timeoutMs: CLAUDE_TIMEOUT_MS }),
  );
  if (result.timedOut) throw new Error('Claude Code did not answer within 20 minutes.');

  const parsed = parseJson(result.stdout);
  if (parsed && parsed.is_error === false && typeof parsed.result === 'string') {
    if (parsed.stop_reason === 'max_tokens') throw new Error('Claude Code stopped before the answer was complete.');
    if (parsed.stop_reason === 'refusal') throw new Error('Claude declined to process this transcript.');
    return { text: parsed.result };
  }
  const detail =
    (typeof parsed?.result === 'string' && parsed.result.trim()) ||
    lastLines(result.stderr) ||
    lastLines(result.stdout) ||
    `exit code ${result.code}`;
  throw new Error(`Claude Code failed: ${detail}`);
}

// Use the browser that started the helper, so the PDF looks the same as in that browser.
async function findBrowser() {
  const parent = await run('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { timeoutMs: STATUS_TIMEOUT_MS })
    .then((result) => result.stdout.trim())
    .catch(() => '');
  if (BROWSERS.some((name) => parent.endsWith(`.app/Contents/MacOS/${name}`)) && existsSync(parent)) return parent;
  for (const root of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of BROWSERS) {
      const candidate = join(root, `${name}.app`, 'Contents', 'MacOS', name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Google Chrome was not found in Applications, so the summary PDF could not be made.');
}

const PDF_ATTEMPTS = 2;

async function renderPdf({ html }, progress) {
  const browser = await findBrowser();
  const work = await makeTempDir();
  try {
    const page = join(work, 'summary.html');
    const output = join(work, 'summary.pdf');
    await writeFile(page, String(html ?? ''));
    // A separate, throwaway profile: the user's own browser profile is never touched.
    const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain'];
    args.push('--disable-extensions', '--disable-sync', '--disable-background-networking', '--no-pdf-header-footer');
    args.push(`--user-data-dir=${join(work, 'profile')}`, `--print-to-pdf=${output}`, pathToFileURL(page).href);
    // A headless browser launch now and then dies on start-up, so try once more.
    let reason = '';
    for (let attempt = 1; attempt <= PDF_ATTEMPTS && !existsSync(output); attempt += 1) {
      const result = await withHeartbeat(progress, '', () => run(browser, args, { keepStdout: false, timeoutMs: PDF_TIMEOUT_MS }));
      reason = result.timedOut ? 'it took too long' : result.signal ? `stopped by ${result.signal}` : `exit code ${result.code}`;
    }
    if (!existsSync(output)) throw new Error(`The browser could not print the summary PDF (${reason}).`);
    return { data: (await readFile(output)).toString('base64') };
  } finally {
    await removeTempDir(work);
  }
}

const HANDLERS = {
  status,
  'choose-folder': chooseFolder,
  'check-folder': checkFolder,
  'claim-folder': claimFolder,
  'write-file': writeFileChunk,
  'file-exists': fileExists,
  transcribe,
  claude: askClaude,
  pdf: renderPdf,
};

async function handle({ id, type, ...params }) {
  const progress = (message) => send({ id, type: 'progress', message });
  try {
    const handler = HANDLERS[type];
    if (!handler) throw new Error(`Unknown helper request: ${type}`);
    reply(id, { ok: true, ...(await handler(params, progress)) });
  } catch (error) {
    reply(id, { ok: false, error: describe(error) });
  }
}

function exitNow() {
  children.forEach((child) => stopChild(child, 'SIGKILL'));
  tempDirs.forEach((dir) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A program that is still being killed can hold the folder for a moment.
    }
  });
  process.exit(0);
}

// Programs get a moment to stop after SIGTERM. Whatever is still running is then killed, so
// nothing keeps running on its own after Chrome closes the connection.
function shutDown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (children.size === 0) exitNow();
  children.forEach((child) => stopChild(child));
  setTimeout(exitNow, SHUTDOWN_GRACE_MS);
}

let queue = Promise.resolve();
readMessages((message) => {
  queue = queue.then(() => handle(message));
});
process.stdin.on('end', shutDown);
process.stdout.on('error', shutDown);
['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => process.on(signal, shutDown));
