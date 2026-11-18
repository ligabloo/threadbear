// The runner's helper on Windows (src/win32-helper.ts and .ps1), and peer
// identity's use of it (src/peer.ts): which process holds a connection,
// walked up through its parents to a thread's CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { nullLogger } from '../../src/log.ts';
import { threadOfSocket } from '../../src/peer.ts';
import { Win32Helper, parsePids, parseProcesses, winAddress } from '../../src/win32-helper.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { onlyOnWindows } from '../helpers/platform.ts';

// A stand-in that speaks the helper's lines: answers ping, echoes its op
// for anything else, and never answers "hang".
const STAND_IN = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const r = JSON.parse(l);
  if (r.op === 'hang') return;
  if (r.op === 'bad') return console.log(JSON.stringify({ id: r.id, ok: false, error: 'no such thing' }));
  console.log(JSON.stringify({ id: r.id, ok: true, result: r.op === 'ping' ? 'pong' : r.op + ':' + (r.port ?? '') }));
});`;

const standIn = (timeoutMs = 2000) => new Win32Helper({ command: process.execPath, args: ['-e', STAND_IN], timeoutMs });

test('the helper answers each question by its id, keeps running, and says why when it refuses', async () => {
  const h = standIn();
  try {
    const [a, b] = await Promise.all([h.ask('ping'), h.ask('tcpOwners', { port: 5 })]);
    assert.equal(a, 'pong');
    assert.equal(b, 'tcpOwners:5');
    await assert.rejects(h.ask('bad'), /no such thing/);
    assert.equal(await h.ask('ping'), 'pong', 'still running after a refusal');
  } finally {
    h.stop();
  }
});

test("a question it doesn't answer in time fails, and the next one gets a new helper", async () => {
  const h = standIn(300);
  try {
    await assert.rejects(h.ask('hang'), /in time/);
    assert.equal(await h.ask('ping'), 'pong');
  } finally {
    h.stop();
  }
});

test("a helper that can't start fails the question rather than hanging it", async () => {
  const h = new Win32Helper({ command: '/nowhere/powershell.exe', args: [], timeoutMs: 5000 });
  await assert.rejects(h.ask('ping'), /couldn't start|exited/);
});

test('its text answers parse, and odd lines are dropped', () => {
  assert.deepEqual(parseProcesses('4 0 0\r\n1200 800 133761234567890123\nnot a row\n'), [
    { pid: 4, ppid: 0, created: 0n },
    { pid: 1200, ppid: 800, created: 133761234567890123n },
  ]);
  assert.deepEqual(parsePids('12\r\n12\n\n34\nx'), [12, 34]);
  assert.equal(winAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(winAddress('::1'), '::1');
});

// Windows keeps a dead process's id as its children's parent id, and hands
// the id to the next process. A thread's CLI that got that id later mustn't
// count as the parent of something that started before it.
test("on Windows a parent that started after its child isn't its parent", async () => {
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const registry = { threadOfPid: (p: number) => (p === 300 ? 'th1' : undefined) };
  const look = (cliStarted: bigint) =>
    threadOfSocket(sock, {
      registry,
      known: () => true,
      log: nullLogger,
      platform: 'win32',
      lsof: async () => [500],
      table: async () => [
        { pid: 500, ppid: 400, created: 2000n }, // what connected
        { pid: 400, ppid: 300, created: 1500n }, // its shell
        { pid: 300, ppid: 1, created: cliStarted }, // a thread's CLI, or a process that took a dead one's id
      ],
    });
  assert.equal(await look(1000n), 'th1', 'started first: its parent');
  assert.equal(await look(1600n), undefined, 'started after the shell: only has a dead parent\'s id');
  assert.equal(await look(0n), 'th1', "Windows wouldn't say when: the id stands, as on a Mac");
});

test('on Windows a real connection is found through the helper', onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const child = spawn(process.execPath, ['-e', `require('net').connect(${port},'127.0.0.1');setTimeout(()=>{},600000)`], { stdio: 'ignore', windowsHide: true });
  const peer = new Promise<net.Socket>((r) => server.once('connection', r));
  let s: net.Socket | undefined;
  try {
    s = await peer;
    // The child is killed at the end, which resets this end.
    s.on('error', () => {});
    const sock = { remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! };
    // The first question starts PowerShell, which takes a second or more on a loaded machine.
    const lookupMs = PATIENCE_MS;
    assert.equal(await threadOfSocket(sock, { registry: { threadOfPid: (p) => (p === child.pid ? 'th9' : undefined) }, known: () => true, log: nullLogger, lookupMs }), 'th9');
    // Under another process: its parent (this test) is the CLI.
    assert.equal(await threadOfSocket(sock, { registry: { threadOfPid: (p) => (p === process.pid ? 'th8' : undefined) }, known: () => true, log: nullLogger, lookupMs }), 'th8');
    // Nobody's: the credential decides.
    assert.equal(await threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, lookupMs }), undefined);
  } finally {
    child.kill();
    s?.destroy();
    server.close();
    (await import('../../src/win32-helper.ts')).win32Helper().stop();
  }
});
