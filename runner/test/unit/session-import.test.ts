// Importing Claude Code sessions (docs/protocol.md, "Importing Claude Code
// sessions"): the CLI's transcripts and the desktop app's session files
// become threads that resume the same session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAccounts, makeHarness, tmpDir } from '../helpers/fakes.ts';
import { Projects } from '../../src/projects.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { projectDirName } from '../../src/transcripts.ts';
import { desktopSessionsDir, findSessions, readConversation } from '../../src/session-import.ts';

const SID = '6a4f2d1c-0b7e-4c1a-9d3e-5f8a7b6c4d21';

function setup(opts: { separateLogin?: boolean; projects?: boolean } = {}) {
  const main = tmpDir('tb-login-main-');
  const other = tmpDir('tb-login-other-');
  const folder = tmpDir('tb-folder-');
  const transcriptLogin = opts.separateLogin ? other : main;
  const dir = path.join(transcriptLogin, 'projects', projectDirName(fs.realpathSync(folder)));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
    line({ type: 'user', cwd: folder, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', cwd: folder, isMeta: true, message: { role: 'user', content: 'meta' } }),
    line({ type: 'user', cwd: folder, message: { role: 'user', content: 'Add a dark mode toggle' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, it is in Settings.' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Thanks' }] } }),
    'not json',
  ].join('\n'));
  const home = tmpDir();
  const projects = opts.projects ? new Projects({ home, clock: new FakeClock(), log: nullLogger, userHome: tmpDir() }) : undefined;
  const h = makeHarness(home, {}, projects ? { projects } : {});
  projects?.start(h.runner);
  (h.runner as any).accounts = new FakeAccounts([
    { id: 'claude-main', provider: 'claude', title: 'main@example.com', configDir: main },
    { id: 'claude-3', provider: 'claude', title: 'three@example.com', configDir: other },
  ]);
  return { h, main, other, folder, dir };
}

test('the conversation is the person\'s and the assistant\'s words, in order', () => {
  const { dir } = setup();
  const { messages, total } = readConversation(path.join(dir, `${SID}.jsonl`));
  assert.equal(total, 3);
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['user', 'Add a dark mode toggle'],
    ['assistant', 'Looking.\n\nDone, it is in Settings.'],
    ['user', 'Thanks'],
  ]);
});

test('a session is listed until it is a thread', () => {
  const { h, folder } = setup();
  const before = h.runner.importable().sessions;
  assert.equal(before.length, 1);
  assert.equal(before[0].sessionId, SID);
  assert.equal(before[0].cwd, folder);
  assert.equal(before[0].title, 'Add a dark mode toggle');
  h.runner.importSession({ sessionId: SID });
  assert.equal(h.runner.importable().sessions.length, 0);
});

test('importing makes a finished thread that resumes the session', () => {
  const { h, folder } = setup();
  const { thread } = h.runner.importSession({ sessionId: SID });
  assert.equal(thread.cwd, folder);
  assert.equal(thread.accountId, 'claude-main');
  assert.equal(h.adapter.sessions.length, 0, 'no CLI started');
  const evs = h.events(thread.id);
  assert.deepEqual(evs.map((e) => e.type), [
    'system.note', 'user.message', 'turn.started', 'assistant.text', 'turn.completed',
    'user.message', 'turn.started', 'turn.completed',
  ]);
  assert.match(evs[0].text, /Imported from Claude Code\./);
  assert.match(h.runner.get(thread.id).preview, /Settings/);
  const rec = (h.runner as any).threads.get(thread.id).rec;
  assert.equal(rec.nativeSessionId, SID);
  assert.equal(rec.sessionUsed, true);
});

test('the same session cannot be imported twice', () => {
  const { h } = setup();
  h.runner.importSession({ sessionId: SID });
  assert.throws(() => h.runner.importSession({ sessionId: SID }), /already the thread/);
});

test('another login gets a copy of the transcript and the original stays', () => {
  const { h, main, other, folder } = setup({ separateLogin: true });
  const { thread } = h.runner.importSession({ sessionId: SID, accountId: 'claude-main' });
  assert.equal(thread.accountId, 'claude-main');
  const name = projectDirName(fs.realpathSync(folder));
  assert.ok(fs.existsSync(path.join(main, 'projects', name, `${SID}.jsonl`)), 'copied to the login');
  assert.ok(fs.existsSync(path.join(other, 'projects', name, `${SID}.jsonl`)), 'original kept');
});

test('a session whose folder is gone needs another folder', () => {
  const { h, folder } = setup();
  fs.rmSync(folder, { recursive: true });
  assert.throws(() => h.runner.importSession({ sessionId: SID }), /isn't on this Mac/);
  const other = tmpDir('tb-new-folder-');
  const { thread } = h.runner.importSession({ sessionId: SID, cwd: other });
  assert.equal(path.basename(thread.cwd), path.basename(other));
});

test('a session id that is not one is refused', () => {
  const { h } = setup();
  assert.throws(() => h.runner.importSession({ sessionId: '../../etc/passwd' }), /session id/);
});

test('the desktop app\'s title, archive and star marks come along', () => {
  const { h, folder } = setup();
  const desktop = tmpDir('tb-desktop-');
  const dir = path.join(desktop, 'a', 'b');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_x.json'), JSON.stringify({
    sessionId: 'local_x', cliSessionId: SID, cwd: folder, title: 'Dark mode', isArchived: true, isStarred: true, model: 'claude-sonnet-5-5', permissionMode: 'auto',
  }));
  const found = findSessions([(h.runner as any).accounts.list()[0].configDir], desktop);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].source, found[0].title, found[0].archived, found[0].starred, found[0].permissionMode], ['desktop', 'Dark mode', true, true, 'auto']);
});

test('into a project puts the thread with others from its folder', () => {
  const { h } = setup({ projects: true });
  assert.ok(h.runner.projects, 'the harness has projects');
  const { thread } = h.runner.importSession({ sessionId: SID, intoProject: true });
  const summary = h.runner.get(thread.id);
  assert.equal(summary.projects?.length, 1);
});

test('sessions an orchestrating session started nest under its thread', () => {
  const { h, main, folder } = setup();
  const CHILD = '7b5a3e2d-1c8f-4d2b-8e4f-6a9b8c7d5e32';
  const SIDE = '8c6b4f3e-2d9a-4e3c-9f5a-7b0c9d8e6f43';
  const dir = path.join(main, 'projects', projectDirName(fs.realpathSync(folder)));
  for (const id of [CHILD, SIDE]) fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: folder, message: { role: 'user', content: `work ${id.slice(0, 4)}` } }));
  const desktop = tmpDir('tb-desktop-');
  const put = (name: string, j: object) => fs.writeFileSync(path.join(desktop, `${name}.json`), JSON.stringify(j));
  put('a', { sessionId: 'local_parent', cliSessionId: SID, cwd: folder });
  put('b', { sessionId: 'local_child', cliSessionId: CHILD, cwd: folder, spawnedFrom: { sessionId: 'local_parent', sideSession: true, name: 'panes-grid' } });
  put('c', { sessionId: 'local_side', cliSessionId: SIDE, cwd: folder, spawnedFrom: { sessionId: 'local_parent', btw: true, userFork: true } });
  const found = findSessions([main], desktop);
  const by = (id: string) => found.find((s) => s.sessionId === id)!;
  assert.equal(by(SID).parentSessionId, undefined);
  assert.deepEqual([by(CHILD).parentSessionId, by(CHILD).spawnedAs], [SID, 'agent']);
  assert.deepEqual([by(SIDE).parentSessionId, by(SIDE).spawnedAs], [SID, 'side']);
});

test('importing with children makes the nested threads', () => {
  const { h, main, folder } = setup();
  const CHILD = '7b5a3e2d-1c8f-4d2b-8e4f-6a9b8c7d5e32';
  const dir = path.join(main, 'projects', projectDirName(fs.realpathSync(folder)));
  fs.writeFileSync(path.join(dir, `${CHILD}.jsonl`), JSON.stringify({ type: 'user', cwd: folder, message: { role: 'user', content: 'child work' } }));
  // HOME is private to the tests, so this is the desktop app's folder for the runner.
  const notes = desktopSessionsDir();
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'a.json'), JSON.stringify({ sessionId: 'local_parent', cliSessionId: SID, cwd: folder }));
  fs.writeFileSync(path.join(notes, 'b.json'), JSON.stringify({ sessionId: 'local_child', cliSessionId: CHILD, cwd: folder, spawnedFrom: { sessionId: 'local_parent', sideSession: true } }));
  try {
    const r = h.runner.importSession({ sessionId: SID, withChildren: true });
    assert.equal(r.children.length, 1);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.children[0].startedBy?.threadId, r.thread.id);
    assert.equal(r.children[0].startedBy?.kind, 'thread');
  } finally {
    fs.rmSync(notes, { recursive: true, force: true });
  }
});
