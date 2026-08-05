// The Keyboard Lock API is Chrome-only and absent from the standard DOM typings.
// See docs/10-limitations.md tier 0.4.
interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}
interface Navigator {
  readonly keyboard?: KeyboardLock;
}
