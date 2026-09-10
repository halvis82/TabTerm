import { describe, expect, it } from 'vitest';
import { describeProgram, noteForProgram } from './port-programs.js';

/**
 * What a name beside a port is allowed to claim.
 *
 * The list answers "what is listening" and the question somebody has is "should I care". This is
 * the second answer, and it is a table of names, which is safe here only because the failure mode
 * is silence: an unknown program gets no note and its row is unchanged.
 */
describe('describing the program holding a port', () => {
  it('names a system service and says that is what it is', () => {
    expect(describeProgram('rapportd')).toBe('Apple Continuity and Handoff, a system process');
    expect(noteForProgram('rapportd')?.system).toBe(true);
  });

  it('says how something was started when the name is only a runtime', () => {
    // python3.11 on a port is not Python doing anything. It is whatever was run with it.
    expect(describeProgram('python3.11')).toBe('something you ran with Python');
    expect(describeProgram('node')).toBe('something you ran with Node');
    expect(describeProgram('bun')).toBe('something you ran with Bun');
  });

  it('does not treat a longer name as a versioned runtime', () => {
    // `nodemon` is not `node`, and guessing here would put a wrong sentence on somebody's screen.
    expect(describeProgram('nodemon')).toBe('');
    expect(describeProgram('gopls')).toBe('');
  });

  it('is silent about anything it does not know', () => {
    expect(describeProgram('some-tool-nobody-has-heard-of')).toBe('');
    expect(describeProgram('')).toBe('');
    expect(noteForProgram('   ')).toBeNull();
  });

  it('reads a name however it is capitalised', () => {
    expect(describeProgram('Google Chrome')).not.toBe('');
    expect(describeProgram('google chrome')).toBe(describeProgram('Google Chrome'));
  });
});
