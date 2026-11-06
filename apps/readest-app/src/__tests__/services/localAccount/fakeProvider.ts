import type { FileEntry, FileSyncProvider } from '@/services/sync/file/provider';

/**
 * In-memory {@link FileSyncProvider} for the local-account tests.
 *
 * The local account layer is written against the provider interface, so a Map
 * backed fake exercises every code path (paths, JSON round trips, listings,
 * deletes) without a WebDAV server.
 */
export class FakeProvider implements FileSyncProvider {
  readonly rootPath = '/books';
  readonly texts = new Map<string, string>();
  readonly binaries = new Map<string, ArrayBuffer>();

  async readText(path: string): Promise<string | null> {
    return this.texts.get(path) ?? null;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.binaries.get(path) ?? null;
  }

  async head(path: string) {
    const text = this.texts.get(path);
    if (text !== undefined) return { size: text.length };
    const binary = this.binaries.get(path);
    if (binary) return { size: binary.byteLength };
    return null;
  }

  async list(path: string): Promise<FileEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries = new Map<string, FileEntry>();
    const consider = (fullPath: string, size: number) => {
      if (!fullPath.startsWith(prefix)) return;
      const rest = fullPath.slice(prefix.length);
      if (!rest) return;
      const [name, ...tail] = rest.split('/');
      const isDirectory = tail.length > 0;
      const entryPath = `${prefix}${name}`;
      if (!entries.has(entryPath)) {
        entries.set(entryPath, {
          name: name!,
          path: entryPath,
          isDirectory,
          ...(isDirectory ? {} : { size }),
        });
      }
    };
    for (const [p, body] of this.texts) consider(p, body.length);
    for (const [p, body] of this.binaries) consider(p, body.byteLength);
    return [...entries.values()];
  }

  async writeText(path: string, body: string): Promise<void> {
    this.texts.set(path, body);
  }

  async writeBinary(path: string, body: ArrayBuffer): Promise<void> {
    this.binaries.set(path, body);
  }

  async ensureDir(): Promise<void> {
    // Directories are implicit in the Map.
  }

  async deleteFile(path: string): Promise<void> {
    this.texts.delete(path);
    this.binaries.delete(path);
  }

  async deleteDir(path: string): Promise<void> {
    for (const key of [...this.texts.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.texts.delete(key);
    }
    for (const key of [...this.binaries.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.binaries.delete(key);
    }
  }

  json<T>(path: string): T | null {
    const text = this.texts.get(path);
    return text ? (JSON.parse(text) as T) : null;
  }
}

export const LOCAL_CONFIG = {
  serverUrl: 'https://dav.example.com',
  username: 'reader',
  password: 'secret',
  rootPath: '/books',
};
