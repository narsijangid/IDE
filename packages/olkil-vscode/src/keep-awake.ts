import { spawn, type ChildProcess } from 'child_process';

/** Holds a Windows display+system awake request until the process is killed. */
const AWAKE_SCRIPT = `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class OlkilAwake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
[OlkilAwake]::SetThreadExecutionState([uint32]2147483651) | Out-Null
while ($true) { Start-Sleep -Seconds 3600 }
`;

export class KeepAwake {
  private child: ChildProcess | null = null;

  isOn() {
    return !!this.child && this.child.exitCode == null && !this.child.killed;
  }

  pid() {
    return this.child?.pid;
  }

  async start(stalePid?: number): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    if (stalePid && stalePid !== this.child?.pid) {
      try {
        process.kill(stalePid);
      } catch {
        /* previous helper already exited */
      }
    }
    if (this.isOn()) return true;
    const encoded = Buffer.from(AWAKE_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'ignore' },
    );
    this.child = child;
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    const alive = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.child === child && child.exitCode == null), 1200);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!alive) this.child = null;
    return alive;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
