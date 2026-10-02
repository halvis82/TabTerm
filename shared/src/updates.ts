/** Public release metadata describes the companion, independently of store approval. */
export interface CompanionRelease {
  schema: 1;
  version: string;
  tag: string;
  commit: string;
  source: { url: string; sha256: string; bytes: number };
  compatibility: {
    protocol: number;
    host: number;
    storage: number;
    nodeMajor: number;
    macosMajor: number;
  };
}
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'current'
  | 'preparing'
  | 'installing'
  | 'updated'
  | 'rolled-back'
  | 'error'
  | 'manual';
export interface CompanionUpdateStatus {
  installedVersion: string;
  availableVersion?: string;
  phase: UpdatePhase;
  message: string;
  checkedAt?: number;
  automaticChecks: boolean;
  automaticInstall: boolean;
  canInstall: boolean;
}
export const COMPANION_COMPATIBILITY = {
  protocol: 1,
  host: 1,
  storage: 1,
  nodeMajor: 22,
  macosMajor: 13,
} as const;
export const RELEASE_API = 'https://api.github.com/repos/halvis82/TabTerm/releases/latest';
export function validVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every((n) => Number(n) <= 65535)
  );
}
export function compareVersions(a: string, b: string): number {
  if (!validVersion(a) || !validVersion(b)) throw new Error('Invalid version');
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign((x[i] ?? 0) - (y[i] ?? 0));
  return 0;
}
export function parseCompanionRelease(value: unknown): CompanionRelease {
  if (!value || typeof value !== 'object') throw new Error('Invalid companion release');
  const v = value as Partial<CompanionRelease>;
  if (
    v.schema !== 1 ||
    !validVersion(v.version) ||
    v.tag !== `v${v.version}` ||
    !/^[a-f0-9]{40}$/.test(v.commit ?? '')
  )
    throw new Error('Invalid companion release identity');
  if (
    !v.source ||
    v.source.url !==
      `https://github.com/halvis82/TabTerm/releases/download/${v.tag}/tabterm-companion-${v.version}.tar.gz` ||
    !/^[a-f0-9]{64}$/.test(v.source.sha256) ||
    !Number.isSafeInteger(v.source.bytes) ||
    v.source.bytes < 1 ||
    v.source.bytes > 50 * 1024 * 1024
  )
    throw new Error('Invalid companion source asset');
  const c = v.compatibility;
  if (
    !c ||
    !['protocol', 'host', 'storage', 'nodeMajor', 'macosMajor'].every(
      (key) => Number.isSafeInteger(c[key as keyof typeof c]) && c[key as keyof typeof c] > 0,
    )
  )
    throw new Error('Invalid companion compatibility');
  return v as CompanionRelease;
}
export function compatibilityIssue(release: CompanionRelease): string | null {
  const c = release.compatibility,
    ours = COMPANION_COMPATIBILITY;
  if (c.protocol !== ours.protocol)
    return 'This release needs a different extension protocol. Update the extension and companion together using the setup guide.';
  if (c.host !== ours.host)
    return 'This release changes the terminal service. A manual upgrade is required after saving and closing your sessions.';
  if (c.storage !== ours.storage)
    return 'This release changes stored data compatibility and requires a manual upgrade.';
  if (c.nodeMajor > ours.nodeMajor || c.macosMajor > ours.macosMajor)
    return 'This release requires newer system prerequisites. Follow the setup guide.';
  return null;
}
