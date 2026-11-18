import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

export interface FileOps {
  access(path: string): Promise<void>;
  atomicWrite(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readDirectory(path: string): Promise<string[]>;
  readBytes(path: string): Promise<Buffer>;
  readText(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  installCreate(from: string, to: string): Promise<void>;
  writeExclusive(path: string, content: string | Uint8Array): Promise<void>;
  snapshotDirectory(path: string): Promise<string>;
}

async function durableWriteExclusive(
  file: string,
  content: string | Uint8Array,
) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  );
  try {
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function snapshotDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${childRelative}\0`, "utf8");
        await visit(child, childRelative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${childRelative}\0${await readlink(child)}\0`, "utf8");
      } else {
        hash.update(`f\0${childRelative}\0`, "utf8");
        hash.update(await readFile(child));
        hash.update("\0", "utf8");
      }
    }
  };
  await visit(directory, "");
  return hash.digest("hex");
}

export const nodeFileOps: FileOps = {
  access,
  async atomicWrite(file, content) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await durableWriteExclusive(temporary, content);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  },
  async exists(file) {
    try {
      await stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  },
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  async readDirectory(directory) {
    return readdir(directory);
  },
  async readBytes(file) {
    return readFile(file);
  },
  async readText(file) {
    return readFile(file, "utf8");
  },
  realpath,
  async remove(file) {
    await rm(file, { force: true, recursive: true });
  },
  rename,
  async installCreate(from, to) {
    await link(from, to);
    await rm(from);
  },
  writeExclusive: durableWriteExclusive,
  snapshotDirectory,
};
