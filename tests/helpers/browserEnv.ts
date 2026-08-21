type Listener = (e: unknown) => void;

class FakeLocalStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow {
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, payload: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
}

class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, payload: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
}

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    if (!FakeBroadcastChannel.channels.has(name)) {
      FakeBroadcastChannel.channels.set(name, new Set());
    }
    FakeBroadcastChannel.channels.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    for (const ch of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (ch !== this && ch.onmessage) ch.onmessage({ data });
    }
  }
  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

export type BrowserEnvHandle = {
  window: FakeWindow;
  storage: FakeLocalStorage;
  document: FakeDocument;
  restore: () => void;
};

export function installBrowserEnv(): BrowserEnvHandle {
  const g = globalThis as Record<string, unknown>;
  const before = {
    window: g.window,
    localStorage: g.localStorage,
    document: g.document,
    BroadcastChannel: g.BroadcastChannel,
    self: g.self,
  };

  const window = new FakeWindow();
  const storage = new FakeLocalStorage();
  const document = new FakeDocument();

  g.window = window as unknown;
  g.localStorage = storage as unknown;
  g.document = document as unknown;
  g.BroadcastChannel = FakeBroadcastChannel as unknown;
  g.self = window as unknown;

  return {
    window,
    storage,
    document,
    restore() {
      g.window = before.window;
      g.localStorage = before.localStorage;
      g.document = before.document;
      g.BroadcastChannel = before.BroadcastChannel;
      g.self = before.self;
      FakeBroadcastChannel.channels.clear();
    },
  };
}
