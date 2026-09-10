/**
 * What a program holding a port actually is, where that is knowable.
 *
 * A port list answers "what is listening" and not "should I care", and the second question is the
 * one somebody actually has. `rapportd` on three high ports looks like something worth
 * investigating and is Apple's Continuity service doing its job.
 *
 * A table of names, which is the thing this file is careful about. It is safe here for one reason:
 * the failure mode is silence. A program nobody has heard of gets no note and its row is exactly
 * what it was. Nothing is hidden, filtered or acted on by name, so a stale entry costs a wrong
 * sentence rather than a missing server. That is why the same approach was refused in the daemon,
 * where a name decides what a person is shown.
 *
 * Two kinds of note. A program that **is** the thing gets what it is. A runtime that is merely how
 * something was started gets said as much, because `python3.11` on 8300 is not Python doing
 * anything, it is whatever was run with it.
 */
export interface ProgramNote {
  text: string;
  /** Belongs to the operating system rather than to anything this person started. */
  system?: true;
}

const EXACT = new Map<string, ProgramNote>([
  // Apple's own, which is most of what a clean machine has listening.
  ['rapportd', { text: 'Apple Continuity and Handoff', system: true }],
  ['controlcenter', { text: 'Control Center, usually AirPlay Receiver', system: true }],
  ['sharingd', { text: 'Apple sharing, including AirDrop', system: true }],
  ['airplayxpchelper', { text: 'AirPlay', system: true }],
  ['remoted', { text: 'Apple device services', system: true }],
  ['launchd', { text: 'the service manager', system: true }],
  ['sshd', { text: 'incoming SSH', system: true }],

  // Applications a person installed and would recognise.
  ['google chrome', { text: 'the browser you are reading this in' }],
  ['raycast', { text: 'the Raycast launcher' }],
  ['docker', { text: 'Docker' }],
  ['com.docker.backend', { text: 'Docker' }],
  ['limactl', { text: 'a Lima virtual machine, often underneath Docker' }],
  ['colima', { text: 'Colima, a Docker runtime' }],
  ['ollama', { text: 'Ollama, running local models' }],
  ['syncthing', { text: 'Syncthing' }],
  ['code', { text: 'Visual Studio Code' }],
  ['adb', { text: 'Android Debug Bridge' }],
  ['spotify', { text: 'Spotify' }],

  // Servers, where the name is the thing.
  ['postgres', { text: 'a PostgreSQL database' }],
  ['redis-server', { text: 'a Redis server' }],
  ['mysqld', { text: 'a MySQL database' }],
  ['mongod', { text: 'a MongoDB database' }],
  ['nginx', { text: 'an nginx server' }],
  ['caddy', { text: 'a Caddy server' }],
  ['ssh', { text: 'an SSH tunnel' }],
  ['kubectl', { text: 'a kubectl port forward' }],
]);

/**
 * Runtimes, matched on the front of the name because they carry versions.
 *
 * `python3.11`, `node`, `bun`. The note says how it was started rather than what it is, since that
 * is the whole of what the name tells anybody.
 */
const RUNTIMES: readonly (readonly [string, string])[] = [
  ['python', 'Python'],
  ['node', 'Node'],
  ['bun', 'Bun'],
  ['deno', 'Deno'],
  ['ruby', 'Ruby'],
  ['java', 'Java'],
  ['php', 'PHP'],
  ['dotnet', '.NET'],
  ['go', 'Go'],
];

export function noteForProgram(program: string): ProgramNote | null {
  const name = program.trim().toLowerCase();
  if (name === '') return null;

  const exact = EXACT.get(name);
  if (exact) return exact;

  for (const [prefix, label] of RUNTIMES) {
    // `node` matches `node`, `python` matches `python3.11`. `nodemon` matches neither on purpose:
    // anything after the prefix has to be a version rather than more name.
    if (name === prefix || new RegExp(`^${prefix}[0-9._-]*$`).test(name)) {
      return { text: `something you ran with ${label}` };
    }
  }
  return null;
}

/** The note as it is written beside a name, or nothing at all. */
export function describeProgram(program: string): string {
  const note = noteForProgram(program);
  if (!note) return '';
  return note.system ? `${note.text}, a system process` : note.text;
}
