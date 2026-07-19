const DATABASE_NAME = "bridge-media-v1";
const STORE_NAME = "scene-record-images";

export class RecordMediaStore {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private objectUrls = new Map<string, string>();

  constructor(private readonly databaseName = DATABASE_NAME) {}

  async save(recordId: string, dataUrl: string): Promise<boolean> {
    if (!("indexedDB" in window)) {
      return false;
    }
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const database = await this.open();
      await runRequest(database, "readwrite", (store) => store.put(blob, recordId));
      this.revoke(recordId);
      this.objectUrls.set(recordId, URL.createObjectURL(blob));
      return true;
    } catch {
      return false;
    }
  }

  async load(recordId: string): Promise<string | null> {
    const cached = this.objectUrls.get(recordId);
    if (cached) {
      return cached;
    }
    if (!("indexedDB" in window)) {
      return null;
    }
    try {
      const database = await this.open();
      const blob = await runRequest<Blob | undefined>(
        database,
        "readonly",
        (store) => store.get(recordId),
      );
      if (!blob) {
        return null;
      }
      const url = URL.createObjectURL(blob);
      this.objectUrls.set(recordId, url);
      return url;
    } catch {
      return null;
    }
  }

  async delete(recordId: string): Promise<void> {
    this.revoke(recordId);
    if (!("indexedDB" in window)) {
      return;
    }
    try {
      const database = await this.open();
      await runRequest(database, "readwrite", (store) => store.delete(recordId));
    } catch {
      // Local metadata deletion should still succeed if IndexedDB is unavailable.
    }
  }

  /**
   * Copy a stored blob to a new key so the destination owns an independent
   * asset. Used when publishing a CapturedPhoto to a SceneRecord: the post
   * gets its own media key and survives deletion of the source photo.
   * Resolves to the destination object URL, or null if the source is missing.
   */
  async copy(sourceKey: string, destKey: string): Promise<string | null> {
    if (!("indexedDB" in window)) {
      const cached = this.objectUrls.get(sourceKey);
      if (!cached) {
        return null;
      }
      try {
        const blob = await fetch(cached).then((response) => response.blob());
        const copiedUrl = URL.createObjectURL(blob);
        this.revoke(destKey);
        this.objectUrls.set(destKey, copiedUrl);
        return copiedUrl;
      } catch {
        return null;
      }
    }
    try {
      const database = await this.open();
      const blob = await runRequest<Blob | undefined>(
        database,
        "readonly",
        (store) => store.get(sourceKey),
      );
      if (!blob) {
        return null;
      }
      await runRequest(database, "readwrite", (store) => store.put(blob, destKey));
      const url = URL.createObjectURL(blob);
      this.revoke(destKey);
      this.objectUrls.set(destKey, url);
      return url;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
    if (!("indexedDB" in window)) {
      return;
    }
    try {
      const database = await this.open();
      await runRequest(database, "readwrite", (store) => store.clear());
    } catch {
      // Clearing localStorage should not be blocked by unavailable media storage.
    }
  }

  async keys(): Promise<string[]> {
    if (!("indexedDB" in window)) {
      return [...this.objectUrls.keys()];
    }
    try {
      const database = await this.open();
      const keys = await runRequest<IDBValidKey[]>(
        database,
        "readonly",
        (store) => store.getAllKeys(),
      );
      return keys.map(String);
    } catch {
      return [];
    }
  }

  async purgeOrphans(retainedKeys: ReadonlySet<string>): Promise<string[]> {
    const orphaned = (await this.keys()).filter((key) => !retainedKeys.has(key));
    await Promise.all(orphaned.map((key) => this.delete(key)));
    return orphaned;
  }

  dispose(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }

  private open(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.databasePromise;
  }

  private revoke(recordId: string): void {
    const url = this.objectUrls.get(recordId);
    if (url) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(recordId);
    }
  }
}

function runRequest<T = IDBValidKey>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export const recordMediaStore = new RecordMediaStore();
