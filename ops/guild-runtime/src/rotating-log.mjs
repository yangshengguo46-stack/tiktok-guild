import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

export class RotatingLog {
  constructor(file, { maxBytes = 10 * 1024 * 1024, backups = 3 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(backups) || backups < 0 || backups > 10) {
      throw new Error('Log limits require 1..67108864 bytes and 0..10 backups.');
    }
    this.file = path.resolve(file);
    this.maxBytes = maxBytes;
    this.backups = backups;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const base = path.basename(this.file);
    for (const name of readdirSync(path.dirname(this.file))) {
      if (!name.startsWith(`${base}.`)) continue;
      const suffix = name.slice(base.length + 1);
      if (/^\d+$/u.test(suffix) && (Number(suffix) > backups || Number(suffix) < 1)) {
        this.requireFile(path.join(path.dirname(this.file), name));
        rmSync(path.join(path.dirname(this.file), name));
      }
    }
    for (let index = 0; index <= backups; index += 1) {
      const target = index === 0 ? this.file : `${this.file}.${index}`;
      if (!existsSync(target)) continue;
      this.requireFile(target);
      const fd = openSync(target, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size > maxBytes) {
          const tail = Buffer.alloc(maxBytes);
          let offset = 0;
          while (offset < maxBytes) {
            const count = readSync(fd, tail, offset, maxBytes - offset, size - maxBytes + offset);
            if (count === 0) break;
            offset += count;
          }
          writeFileSync(target, tail.subarray(0, offset));
        }
      } finally { closeSync(fd); }
    }
    this.requireFile(this.file);
    this.fd = openSync(this.file, 'a');
    this.size = fstatSync(this.fd).size;
  }

  requireFile(file) {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Runtime log must be a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  rotate() {
    closeSync(this.fd);
    this.fd = undefined;
    for (let index = this.backups; index >= 1; index -= 1) {
      const target = `${this.file}.${index}`;
      this.requireFile(target);
      rmSync(target, { force: true });
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`;
      this.requireFile(source);
      if (existsSync(source)) renameSync(source, target);
    }
    if (this.backups === 0) rmSync(this.file, { force: true });
    this.fd = openSync(this.file, 'a');
    this.size = 0;
  }

  write(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.byteLength) {
      if (this.size === this.maxBytes) this.rotate();
      const count = Math.min(this.maxBytes - this.size, buffer.byteLength - offset);
      const written = writeSync(this.fd, buffer, offset, count);
      offset += written;
      this.size += written;
    }
  }

  close() {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
  }
}
