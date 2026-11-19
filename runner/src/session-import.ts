// Finding Claude Code sessions to bring in as threads (docs/protocol.md,
// "Importing Claude Code sessions"). Reads, never changes:
//   <configDir>/projects/<folder as a name>/<sessionId>.jsonl  the CLI's transcripts
//   ~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json
//     what the Claude desktop app keeps about each of its Code sessions
//     (title, folder, archived, starred, model), keyed by `cliSessionId`.
// Both lay their files out in ways nobody documents, so every read is
// forgiving: a line or file that doesn't look right is skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ImportableSession {
  sessionId: string;
  cwd: string;
  title: string;
  /** The first thing said in it, one line. */
  firstMessage: string;
  /** ms since epoch: when the transcript was last written. */
  lastActivityAt: number;
  /** The login folder that holds the transcript. */
  configDir: string;
  /** Where the title and settings came from. */
  source: 'cli' | 'desktop';
  /** The session that started this one (its CLI session id), from the desktop app's notes. */
  parentSessionId?: string;
  /** `side` for a side question or fork of the parent's, `agent` for one an orchestrating session sent off to work. */
  spawnedAs?: 'agent' | 'side';
  archived?: boolean;
  starred?: boolean;
  model?: string;
  effort?: string;
  permissionMode?: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Enough of a file's start to find its folder and first message.
const HEAD_BYTES = 256 * 1024;
const TITLE_CHARS = 80;

export function desktopSessionsDir(home = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

export function isSessionId(s: unknown): s is string {
  return typeof s === 'string' && SESSION_ID.test(s);
}

// What the desktop app knows about each CLI session, by the CLI's id.
export function readDesktopMeta(dir: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(f, depth + 1);
      } else if (e.name.endsWith('.json')) {
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
          const id = j.cliSessionId;
          if (!isSessionId(id)) continue;
          // The same session can be written more than once; the newest wins.
          const have = out.get(id);
          if (!have || Number(j.lastActivityAt ?? 0) >= Number(have.lastActivityAt ?? 0)) out.set(id, j);
        } catch {
          // not one of theirs
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

// The text of a user entry the person typed, or undefined for anything else
// (tool results, the CLI's own reminders, slash command echoes).
function userText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content as { type?: string; text?: string }[]) if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
  }
  text = text.trim();
  if (!text || /^<(command-name|command-message|local-command|system-reminder|bash-)/.test(text)) return undefined;
  return text;
}

function assistantText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'assistant' || entry.isSidechain === true) return undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  let text = '';
  for (const b of content as { type?: string; text?: string }[]) if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n\n' : '') + b.text;
  text = text.trim();
  return text || undefined;
}

function lines(file: string, maxBytes?: number): string[] {
  let text: string;
  if (maxBytes === undefined) text = fs.readFileSync(file, 'utf8');
  else {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  return text.split('\n').filter(Boolean);
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(line);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// The folder and first message of a transcript, from its start. Undefined
// when nobody said anything in it (a session opened and closed).
function readHead(file: string): { cwd?: string; first: string } | undefined {
  let cwd: string | undefined;
  for (const line of lines(file, HEAD_BYTES)) {
    const e = parse(line);
    if (!e) continue;
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    const text = userText(e);
    if (text !== undefined) return { ...(cwd ? { cwd } : {}), first: text };
  }
  return undefined;
}

// Every session under these login folders, newest first. `desktopDir`
// adds the desktop app's titles and settings (and its archived and
// starred marks) to the sessions it knows.
export function findSessions(configDirs: string[], desktopDir?: string): ImportableSession[] {
  const meta = desktopDir ? readDesktopMeta(desktopDir) : new Map<string, Record<string, unknown>>();
  // The desktop app names sessions its own way (local_...); the CLI's id is
  // what a transcript and a thread know.
  const cliIdOf = new Map<string, string>();
  for (const [cli, j] of meta) if (typeof j.sessionId === 'string') cliIdOf.set(j.sessionId, cli);
  const seen = new Set<string>();
  const out: ImportableSession[] = [];
  for (const configDir of configDirs) {
    const root = path.join(configDir, 'projects');
    let folders: string[];
    try {
      folders = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const folder of folders) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(root, folder));
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!isSessionId(sessionId) || seen.has(sessionId)) continue;
        const file = path.join(root, folder, name);
        try {
          const head = readHead(file);
          const d = meta.get(sessionId);
          const cwd = typeof d?.cwd === 'string' ? d.cwd : head?.cwd;
          if (!head || !cwd) continue;
          seen.add(sessionId);
          const title = typeof d?.title === 'string' && d.title.trim() ? d.title.trim() : oneLine(head.first, TITLE_CHARS);
          const spawn = d?.spawnedFrom as { sessionId?: unknown; btw?: unknown; userFork?: unknown } | undefined;
          const parentLocal = typeof spawn?.sessionId === 'string' ? spawn.sessionId : typeof d?.forkedFromSessionId === 'string' ? d.forkedFromSessionId : undefined;
          const parent = parentLocal ? cliIdOf.get(parentLocal) : undefined;
          out.push({
            sessionId,
            cwd,
            title,
            firstMessage: oneLine(head.first, 200),
            lastActivityAt: Math.round(fs.statSync(file).mtimeMs),
            configDir,
            source: d ? 'desktop' : 'cli',
            ...(parent && parent !== sessionId ? { parentSessionId: parent, spawnedAs: spawn?.btw || spawn?.userFork || !spawn ? ('side' as const) : ('agent' as const) } : {}),
            ...(d?.isArchived === true ? { archived: true } : {}),
            ...(d?.isStarred === true ? { starred: true } : {}),
            ...(typeof d?.model === 'string' ? { model: d.model } : {}),
            ...(typeof d?.effort === 'string' ? { effort: d.effort } : {}),
            ...(typeof d?.permissionMode === 'string' ? { permissionMode: d.permissionMode } : {}),
          });
        } catch {
          // unreadable; leave it out
        }
      }
    }
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

// What was said in a session, in order: the person's messages and the
// assistant's words. Tool calls and results, thinking and sub-agents'
// work stay in the CLI's own transcript, which the thread carries on from.
export function readConversation(file: string, last = 100): { messages: TranscriptMessage[]; total: number } {
  const all: TranscriptMessage[] = [];
  for (const line of lines(file)) {
    const e = parse(line);
    if (!e) continue;
    const u = userText(e);
    if (u !== undefined) {
      all.push({ role: 'user', text: u });
      continue;
    }
    const a = assistantText(e);
    if (a !== undefined) {
      // One reply is often several entries (text, a tool call, more text).
      const prev = all[all.length - 1];
      if (prev?.role === 'assistant') prev.text += `\n\n${a}`;
      else all.push({ role: 'assistant', text: a });
    }
  }
  return { messages: all.slice(-last), total: all.length };
}
