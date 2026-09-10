import type { OtherLocalPort } from '@tabterm/shared';

/**
 * Ports gathered under the program holding them.
 *
 * One row per port is what the machine gives and not what a person reads. Measured on a working
 * machine: 26 loopback ports, twelve of them one browser's helper processes. Twelve rows saying
 * "Google Chrome" is a wall; one row saying "Google Chrome (12)" is a fact, and folding it away is
 * a decision somebody can make once.
 *
 * Groups are ordered by their lowest port rather than by name, so the thing a person started most
 * recently on a high port does not sort itself under A. Ports inside a group ascend, because that
 * is the only order a port has.
 */
export interface PortGroup {
  program: string;
  ports: readonly OtherLocalPort[];
}

export function groupPorts(ports: readonly OtherLocalPort[]): PortGroup[] {
  const byProgram = new Map<string, OtherLocalPort[]>();
  for (const port of ports) {
    const key = port.program === '' ? 'unknown' : port.program;
    const list = byProgram.get(key);
    if (list) list.push(port);
    else byProgram.set(key, [port]);
  }

  const groups: PortGroup[] = [];
  for (const [program, list] of byProgram) {
    groups.push({ program, ports: [...list].sort((a, b) => a.port - b.port) });
  }
  groups.sort((a, b) => {
    const lowest = (g: PortGroup) => g.ports[0]?.port ?? Number.MAX_SAFE_INTEGER;
    const byPort = lowest(a) - lowest(b);
    return byPort !== 0 ? byPort : a.program.localeCompare(b.program);
  });
  return groups;
}
