// Write-ahead money ledger: append-only JSONL, fsync'd before any send. State is rebuilt from it on boot, so a crash
// between "intend" and "done" is always visible and never silently repeated. Never truncated.
import fs from 'node:fs';
import path from 'node:path';

export class Ledger {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'a');
    // a crash mid-write leaves a torn last line: start on a fresh line so the next record isn't glued onto it
    try { const st = fs.fstatSync(this.fd); if (st.size > 0) { const b = Buffer.alloc(1); const r = fs.openSync(file, 'r'); fs.readSync(r, b, 0, 1, st.size - 1); fs.closeSync(r); if (b[0] !== 10) fs.writeSync(this.fd, '\n'); } } catch {}
  }
  append(rec) {
    const line = JSON.stringify({ at: Date.now(), ...rec }) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    return rec;
  }
  *read() {
    let txt = '';
    try { txt = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const l of txt.split('\n')) {
      if (!l.trim()) continue;
      try { yield JSON.parse(l); } catch { /* torn last line from a crash: skip */ }
    }
  }
}
