import { describe, expect, it } from 'vitest';
import { VtState } from './vt-state.js';
import { INPUT_STATE_OF_A_NEW_SHELL } from './restored-screen.js';

const HIDE = '[?25l';
const SHOW = '[?25h';
const DRAG = '[?1002h';
const SGR = '[?1006h';

/**
 * What a restored screen has to bring back with it.
 *
 * Reported from a crash: several tabs came back holding agent sessions, and every one of them had
 * a second typing indicator in it. A block at the bottom left of the pane, and another appearing
 * further up and to the right on each character typed, neither of them the agent's own.
 *
 * It was the terminal's real cursor, drawn because the screen that came back no longer said it was
 * hidden. An agent's interface hides the cursor and draws its own, and that mode is carried by the
 * stream rather than by the screen, so a session that is **replayed** rather than watched live
 * loses it. The real cursor then sits wherever the last frame left it, which for that interface is
 * the bottom left, and moves as the frame is redrawn on each keystroke.
 *
 * The serialize addon restores the alternate screen, bracketed paste, mouse tracking and the
 * keypad modes, and says nothing about either of the two below. So the daemon says it.
 */
describe('a screen that comes back from a snapshot', () => {
  it('says the cursor is hidden, when it is', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write('some output\r\n');
    // What an agent's interface does on the way in: hide the cursor and draw its own.
    vt.write(HIDE);
    await vt.flush();
    expect(vt.snapshot(0).screen).toContain(HIDE);
    vt.dispose();
  });

  /*
   * And says so plainly when it is not, rather than leaving it to the default of whatever terminal
   * the screen is written into. A snapshot describes a terminal; a reader should not have to know
   * what this one happened to start as.
   */
  it('and says it is shown when it is shown', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write('a prompt $ ');
    await vt.flush();
    const screen = vt.snapshot(0).screen;
    expect(screen).toContain(SHOW);
    expect(screen).not.toContain(HIDE);
    vt.dispose();
  });

  it('and follows the stream rather than guessing', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write(HIDE);
    vt.write(SHOW);
    await vt.flush();
    expect(vt.snapshot(0).screen).not.toContain(HIDE);
    vt.dispose();
  });

  /**
   * And which mouse encoding the program asked for, for the same reason.
   *
   * Mouse tracking itself is restored and the encoding is not, so a restored program is told about
   * clicks in a format it never asked for. The old format cannot express a column past 95, which
   * is most of a full width terminal, and reports a release as an anonymous button, so what the
   * program sees is clicks in the wrong place or no click at all.
   */
  it('and which format the program asked to hear about the mouse in', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write(`${DRAG}${SGR}`);
    await vt.flush();
    const screen = vt.snapshot(0).screen;
    expect(screen, 'tracking, which the serializer already restores').toContain(DRAG);
    expect(screen, 'and the encoding, which it does not').toContain(SGR);
    vt.dispose();
  });

  it('and says nothing about an encoding nobody asked for', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write('plain output');
    await vt.flush();
    expect(vt.snapshot(0).screen).not.toContain(SGR);
    vt.dispose();
  });
});

/**
 * And what a **restored** screen is allowed to bring with it, which is less.
 *
 * Restoring a workspace puts the saved screen in front of somebody again, in a new shell, because
 * the work on it is worth reading. A serialized screen also carries the modes its program had set,
 * and several of those govern input rather than drawing. Replayed into a new shell they arm that
 * shell's terminal against a process that never asked for any of them.
 *
 * Reported as restored sessions not working at all: a prompt typed into a resumed agent came back
 * as "Interrupted by user", because the stray escape sequences those modes produce start with the
 * byte that program reads as its interrupt key.
 */
describe('a screen restored into a new shell', () => {
  /** A screen as an agent's interface leaves it: four input modes and a hidden cursor. */
  async function screenAnAgentLeftBehind(): Promise<string> {
    const vt = new VtState(80, 24, 100);
    vt.write('a conversation, and some tool output\r\n');
    vt.write('\u001b[?1h\u001b[?1002h\u001b[?1006h\u001b[?1004h\u001b[?2004h\u001b[?25l');
    await vt.flush();
    const { screen } = vt.snapshot(0);
    vt.dispose();
    return screen;
  }

  it('is still the screen, so the work is there to read', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write((await screenAnAgentLeftBehind()) + INPUT_STATE_OF_A_NEW_SHELL);
    await vt.flush();
    expect(vt.snapshot(0).screen).toContain('a conversation, and some tool output');
    vt.dispose();
  });

  /*
   * Every one of these is a way for the terminal to send bytes nobody typed: a click, a window
   * focus change, an arrow key, a paste. The program that asked for them is not running.
   */
  it('and leaves nothing armed that would send input by itself', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write((await screenAnAgentLeftBehind()) + INPUT_STATE_OF_A_NEW_SHELL);
    await vt.flush();
    const restored = vt.snapshot(0).screen;
    for (const [mode, what] of [
      ['\u001b[?1h', 'application cursor keys, so an arrow key sends ESC O A'],
      ['\u001b[?1002h', 'mouse tracking, so a click sends ESC [ M and three bytes'],
      ['\u001b[?1006h', 'and the encoding that goes with it'],
      ['\u001b[?1004h', 'focus reporting, so changing window sends ESC [ I'],
      ['\u001b[?2004h', 'bracketed paste, so a paste is wrapped in ESC [ 200~'],
    ] as const) {
      expect(restored, what).not.toContain(mode);
    }
    vt.dispose();
  });

  it('and gives back a cursor the person can see', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write((await screenAnAgentLeftBehind()) + INPUT_STATE_OF_A_NEW_SHELL);
    await vt.flush();
    expect(vt.snapshot(0).screen).toContain('\u001b[?25h');
    vt.dispose();
  });

  /*
   * And the shell that is actually running can still ask for whatever it wants. This is a reset of
   * what the dead program left, not a terminal that refuses to do these things again.
   */
  it('and the new shell can turn its own modes on afterwards', async () => {
    const vt = new VtState(80, 24, 100);
    vt.write((await screenAnAgentLeftBehind()) + INPUT_STATE_OF_A_NEW_SHELL);
    vt.write('\u001b[?2004h');
    await vt.flush();
    expect(vt.snapshot(0).screen).toContain('\u001b[?2004h');
    vt.dispose();
  });
});
