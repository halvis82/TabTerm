export function startRelay(options?: {
  secret?: string;
  port?: number;
  host?: string;
  linger?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }>;
