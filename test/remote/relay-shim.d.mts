export function startRelay(options?: {
  secret?: string;
  port?: number;
  host?: string;
}): Promise<{ url: string; close: () => Promise<void> }>;
