import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Atomic, owner-only files; callers validate their own schema. Use a private persistent directory. */
export class SecretStore {
  constructor(readonly path: string) {}

  async read(): Promise<unknown> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as unknown; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new Error(`Cannot read credential file ${this.path}; repair it or authenticate again`);
    }
  }

  async write(value: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
