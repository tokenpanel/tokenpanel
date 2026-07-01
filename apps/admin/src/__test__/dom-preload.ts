type Stored = Record<string, string>;

const store: Stored = {};

const localStorageStub: Storage = {
  get length() {
    return Object.keys(store).length;
  },
  clear() {
    for (const k of Object.keys(store)) delete store[k];
  },
  getItem(key: string) {
    return key in store ? store[key]! : null;
  },
  key(index: number) {
    const keys = Object.keys(store);
    return index >= 0 && index < keys.length ? keys[index]! : null;
  },
  removeItem(key: string) {
    delete store[key];
  },
  setItem(key: string, value: string) {
    store[key] = String(value);
  },
};

const eventListeners: Record<string, EventListenerOrEventListenerObject[]> = {};

const windowStub = {
  localStorage: localStorageStub,
  dispatchEvent(e: Event) {
    const type = e.type;
    const listeners = eventListeners[type] ?? [];
    for (const l of listeners) {
      if (typeof l === "function") l(e);
      else l.handleEvent(e);
    }
    return true;
  },
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    (eventListeners[type] ??= []).push(listener);
  },
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const arr = eventListeners[type];
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i >= 0) arr.splice(i, 1);
  },
  CustomEvent: class CustomEvent<T = unknown> {
    type: string;
    detail: T;
    constructor(type: string, init?: { detail?: T }) {
      this.type = type;
      this.detail = (init?.detail ?? undefined) as T;
    }
  } as unknown as typeof CustomEvent,
};

(globalThis as unknown as { localStorage: Storage }).localStorage = localStorageStub;
(globalThis as unknown as { window: typeof windowStub }).window = windowStub;
(globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = windowStub.CustomEvent;