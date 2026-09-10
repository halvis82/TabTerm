import { describe, expect, it } from 'vitest';
import { groupPorts } from './port-groups.js';

/**
 * What the ports list looks like once it is readable.
 *
 * The machine offers one row per port. On a real one that was 26 rows, twelve of which were a
 * single browser's helper processes, which is not a list anybody reads.
 */
describe('grouping ports by what is holding them', () => {
  const ports = [
    { port: 12090, program: 'Google Chrome' },
    { port: 5001, program: 'python3.11' },
    { port: 37701, program: 'bun' },
    { port: 9411, program: 'Google Chrome' },
    { port: 5002, program: 'python3.11' },
  ];

  it('puts every port of one program together', () => {
    const groups = groupPorts(ports);
    const chrome = groups.find((g) => g.program === 'Google Chrome');
    expect(chrome?.ports.map((p) => p.port)).toEqual([9411, 12090]);
  });

  it('orders groups by their lowest port, not alphabetically', () => {
    // Otherwise the thing somebody just started on a high port sorts itself under A.
    expect(groupPorts(ports).map((g) => g.program)).toEqual(['python3.11', 'Google Chrome', 'bun']);
  });

  it('orders ports inside a group, since that is the only order a port has', () => {
    const chrome = groupPorts(ports).find((g) => g.program === 'Google Chrome');
    expect(chrome?.ports.map((p) => p.port)).toEqual([9411, 12090]);
  });

  it('gives a nameless holder a name rather than an empty heading', () => {
    expect(groupPorts([{ port: 4000, program: '' }])[0]?.program).toBe('unknown');
  });

  it('answers nothing for nothing', () => {
    expect(groupPorts([])).toEqual([]);
  });
});
