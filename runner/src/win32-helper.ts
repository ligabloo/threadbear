// The runner's helper process on Windows: one hidden powershell.exe running
// win32-helper.ps1, kept for the runner's life, that answers what ps and
// lsof answer on a Mac (docs/gpui-port/runner-windows-plan.md, slice 5).
// A fresh powershell.exe for each question took 1.5 to 2.5 s on the Dell
// (18 Nov), longer than a connection can wait; this one answers a question
// in 100 to 250 ms once it's up.
//
// It starts on the first question. A question that gets no answer in time
// fails, and the helper is stopped and started again for the next, so a
// stuck PowerShell can't hold the runner up. Answers come back in order,
// one line each.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

export const HELPER_SCRIPT = path.join(import.meta.dirname, 'win32-helper.ps1');

export type HelperDeps = {
  // What to start: tests pass a stand-in that speaks the same lines.
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Win32Helper {
  private child?: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private deps: HelperDeps;

  constructor(deps: HelperDeps = {}) {
    this.deps = deps;
  }

  private start(): ChildProcess {
    const command = this.deps.command ?? 'powershell.exe';
    const args = this.deps.args ?? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT];
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.answer(line));
    // Only the current helper's end fails what's waiting: one stopped for
    // being slow exits after its replacement has been asked something.
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(new Error(why));
    };
    child.on('error', (e) => gone(`the helper couldn't start: ${e.message}`));
    child.on('exit', (code) => gone(`the helper exited (${code})`));
    // Not what keeps the runner alive.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    return child;
  }

  private answer(line: string): void {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line.replace(/^﻿/, ''));
    } catch {
      return;
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(typeof msg.result === 'string' ? msg.result : '');
    else p.reject(new Error(`the helper said: ${String(msg.error ?? 'no reason')}`));
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  // One question, answered as text.
  ask(op: string, params: Record<string, string | number> = {}): Promise<string> {
    const child = this.child ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the helper didn't answer ${op} in time`));
        // Stuck or too slow: the next question gets a new one.
        this.stop();
      }, this.deps.timeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.failAll(new Error('the helper was stopped'));
    child?.kill();
  }
}

// Every process: its pid, its parent's and when it started (a FILETIME, 100
// ns since 1601 UTC, 0 when Windows won't say).
export type WinProcess = { pid: number; ppid: number; created: bigint };

export function parseProcesses(text: string): WinProcess[] {
  const rows: WinProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]!) });
  }
  return rows;
}

export function parsePids(text: string): number[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number))];
}

// Windows names an IPv4-mapped address as plain IPv4 (Node's dual-stack form
// is ::ffff:127.0.0.1).
export function winAddress(addr: string): string {
  return addr.startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
}

let shared: Win32Helper | undefined;

// The runner's one helper.
export function win32Helper(): Win32Helper {
  return (shared ??= new Win32Helper());
}
