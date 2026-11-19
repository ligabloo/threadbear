// Importing Claude Code sessions: the CLI's own and the Claude desktop app's
// Code sessions become threads that carry on the same conversation
// (docs/protocol.md, "Importing Claude Code sessions"). The thread starts
// from the session's id with its transcript already in the login's folder, so
// its next message resumes it. Part of the Runner (runner.ts); each method's
// `this` is the Runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { PermissionMode, ThreadSummary } from '../protocol.ts';
import { ErrorCode, LIMITS, RpcError } from '../protocol.ts';
import { oneLine, userMessage } from '../runner.ts';
import { isDirectory } from '../fsutil.ts';
import { copySessionTranscript, sessionTranscriptPath } from '../transcripts.ts';
import { desktopSessionsDir, findSessions, isSessionId, readConversation, type ImportableSession } from '../session-import.ts';

const MODES: PermissionMode[] = ['full', 'ask', 'auto', 'plan'];

export interface ImportParams {
  sessionId: string;
  /** The folder to run in when the session's own is gone. */
  cwd?: string;
  /** The login to continue on; with none, the one whose folder holds the transcript. */
  accountId?: string;
  title?: string;
  /** Put the thread in a project for its folder, making one if there isn't. */
  intoProject?: boolean;
  /** Also bring in the sessions this one started (and theirs), nested under it. */
  withChildren?: boolean;
}

export interface ImportResult {
  thread: ThreadSummary;
  /** With `withChildren`: the threads made for the sessions it started, parents before their own. */
  children: ThreadSummary[];
  /** With `withChildren`: ones that couldn't come in, and why. */
  skipped: { sessionId: string; error: string }[];
}

export const importingPart = {
  // Where the CLI keeps transcripts on this Mac: each Claude login's folder
  // and the CLI's own ~/.claude.
  importSources(this: Runner): string[] {
    const dirs = this.accounts.list().filter((a) => a.provider === 'claude').map((a) => a.configDir);
    dirs.push(path.join(os.homedir(), '.claude'));
    return [...new Set(dirs)].filter((d) => isDirectory(d));
  },

  // Sessions that aren't threads yet, newest first. The ones the desktop app
  // has archived come only when asked for.
  importable(this: Runner, params: { archived?: boolean; limit?: number } = {}): { sessions: (ImportableSession & { threadId?: string })[] } {
    const taken = new Map<string, string>();
    for (const rec of this.threadRecords()) if (rec.provider === 'claude' && rec.sessionUsed && rec.nativeSessionId) taken.set(rec.nativeSessionId, rec.id);
    const found = findSessions(this.importSources(), desktopSessionsDir());
    const sessions = found.filter((s) => !taken.has(s.sessionId) && (params.archived || !s.archived));
    return { sessions: sessions.slice(0, params.limit ?? sessions.length) };
  },

  importSession(this: Runner, params: ImportParams): ImportResult {
    if (!isSessionId(params.sessionId)) throw new RpcError(ErrorCode.badParams, 'sessionId must be a Claude Code session id');
    const sessionId = params.sessionId.toLowerCase();
    const existing = this.threadRecords().find((r) => r.provider === 'claude' && r.sessionUsed && r.nativeSessionId === sessionId);
    if (existing) throw new RpcError(ErrorCode.badParams, `That session is already the thread ${existing.id} ("${existing.title}").`);
    const session = findSessions(this.importSources(), desktopSessionsDir()).find((s) => s.sessionId === sessionId);
    if (!session) throw new RpcError(ErrorCode.badParams, `No Claude Code session ${sessionId} found on this Mac.`);

    // Its own folder, unless that's gone and another was given.
    const cwd = isDirectory(session.cwd) ? session.cwd : params.cwd;
    if (!cwd || !isDirectory(cwd)) {
      throw new RpcError(ErrorCode.badParams, `The session's folder ${session.cwd} isn't on this Mac. Give another folder to run it in.`);
    }

    // The login whose folder holds the transcript keeps it where it is;
    // another login gets a copy (as a move between logins does).
    const holder = this.accounts.list().find((a) => a.provider === 'claude' && a.configDir === session.configDir);
    const accountId = params.accountId ?? holder?.id;
    const mode = MODES.find((m) => m === session.permissionMode);
    // Started by a session that is a thread here: nests under it like a
    // thread an agent started (docs/protocol.md, "Nested threads").
    const parent = session.parentSessionId ? this.threadRecords().find((r) => r.provider === 'claude' && r.sessionUsed && r.nativeSessionId === session.parentSessionId) : undefined;
    const { st } = this.makeThread({
      ...(parent ? { startedBy: { kind: 'thread' as const, label: 'Agent', threadId: parent.id } } : {}),
      text: session.firstMessage,
      cwd,
      title: params.title?.trim() || session.title,
      ...(accountId ? { accountId } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      worktree: false,
    });
    const { rec } = st;
    const account = this.accounts.get(rec.accountId);
    const copied = account?.provider === 'claude' && copySessionTranscript(session.configDir, account.configDir, session.cwd, cwd, sessionId);
    if (!copied || !account || !sessionTranscriptPath(account.configDir, cwd, sessionId)) {
      this.delete(rec.id);
      throw new RpcError(ErrorCode.other, "The session's transcript couldn't be copied to that login, so nothing was imported.");
    }
    rec.nativeSessionId = sessionId;
    rec.sessionUsed = true;

    // What was said, as finished turns the way a quick ask is kept, so the
    // thread reads as it did. The CLI carries on from its own transcript.
    const file = sessionTranscriptPath(account.configDir, cwd, sessionId)!;
    const { messages, total } = readConversation(file, 100);
    while (messages.length && messages[0].role === 'assistant') messages.shift();
    const origin = session.source === 'desktop' ? 'Claude Code Desktop' : 'Claude Code';
    const omitted = total - messages.length;
    this.emit(st, {
      type: 'system.note',
      text: `Imported from ${origin}. ${omitted > 0 ? `The last ${messages.length} messages are shown; the earlier ${omitted} are still in the session.` : 'The whole conversation is shown.'} Tool calls aren't shown here, but the agent still remembers them.`,
    });
    let last = 0;
    let lastAnswer = '';
    for (let i = 0; i < messages.length; ) {
      const turnId = crypto.randomUUID();
      this.emit(st, userMessage({ turnId, text: messages[i].text, images: [] }), turnId);
      this.emit(st, { type: 'turn.started', turnId }, turnId);
      i++;
      if (messages[i]?.role === 'assistant') {
        lastAnswer = messages[i].text;
        this.emit(st, { type: 'assistant.text', itemId: crypto.randomUUID(), text: lastAnswer }, turnId);
        i++;
      }
      last = this.emit(st, { type: 'turn.completed', turnId, outcome: 'completed', durationMs: 0, needs: 'nothing' }, turnId).seq;
    }
    if (last) {
      rec.needs = { seq: last, needs: 'nothing' };
      rec.lastTurnCompletedSeq = last;
      rec.lastSeenSeq = rec.lastSeq;
    }
    if (lastAnswer) rec.preview = oneLine(lastAnswer, LIMITS.previewChars);
    // Marks from the desktop app.
    const at = this.isoNow();
    if (session.archived) {
      rec.archivedAt = at;
      rec.archivedBy = 'mike';
    }
    if (session.starred) rec.starredAt = at;
    this.markDirty(st);

    if (params.intoProject) this.importProjectFor(rec.id, cwd);
    const result: ImportResult = { thread: this.summary(st), children: [], skipped: [] };
    if (params.withChildren) {
      const taken = new Set(this.threadRecords().filter((r) => r.sessionUsed && r.nativeSessionId).map((r) => r.nativeSessionId));
      for (const child of findSessions(this.importSources(), desktopSessionsDir())) {
        if (child.parentSessionId !== sessionId || taken.has(child.sessionId)) continue;
        try {
          const r = this.importSession({ sessionId: child.sessionId, accountId: params.accountId, intoProject: params.intoProject, withChildren: true });
          result.children.push(r.thread, ...r.children);
          result.skipped.push(...r.skipped);
        } catch (e) {
          result.skipped.push({ sessionId: child.sessionId, error: (e as Error).message });
        }
      }
    }
    return result;
  },

  // The project for a folder (the first whose folders include it, else a new
  // one named for the folder), with the thread in it. A project that can't
  // be made leaves the thread where it is.
  importProjectFor(this: Runner, threadId: string, cwd: string): void {
    const projects = this.projects;
    if (!projects) return;
    try {
      const real = fs.realpathSync(cwd);
      const project = projects.list().find((p) => p.folders.some((f) => f === cwd || f === real)) ?? projects.create({ title: path.basename(real) || real, folders: [real], by: 'mike' });
      projects.changeMembership(threadId, { add: [project.id], by: 'mike' });
    } catch (e) {
      this.log.warn('could not put an imported thread in a project', { threadId, error: String(e) });
    }
  },
};

export type ImportingPart = RunnerPart<typeof importingPart>;
