import type { CompanionUpdateStatus } from '@tabterm/shared';
export class UpdateManager {
  constructor(options: {
    home: string;
    version: string;
    enabled?: boolean;
    port?: number;
    changed?: (value: CompanionUpdateStatus) => void;
    fetchBytes?: (url: string, limit: number) => Promise<Uint8Array>;
    launch?: () => Promise<void>;
    clock?: () => number;
  });
  snapshot(): CompanionUpdateStatus;
  start(): void;
  stop(): void;
  preferencesChanged(checks: boolean, install: boolean): void;
  check(): Promise<void>;
  install(): Promise<void>;
}
