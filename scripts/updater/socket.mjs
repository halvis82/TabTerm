/** An authenticated health response, never merely an open TCP port. */
export function queryDaemon(port, token, message = { t: 'update-health' }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => done(new Error('Companion did not answer')), 4000);
    const done = (error, value) => {
      clearTimeout(timer);
      ws.close();
      error ? reject(error) : resolve(value);
    };
    const send = (msg) =>
      ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(msg))]));
    ws.onopen = () =>
      send({ t: 'auth', v: 1, role: 'control', token, clientId: 'companion-updater' });
    ws.onerror = () => done(new Error('Companion is not reachable'));
    ws.onmessage = (event) => {
      try {
        const bytes = Buffer.from(event.data);
        if (bytes[0] !== 0) return;
        const msg = JSON.parse(bytes.subarray(1).toString());
        if (msg.t === 'auth-ok') send(message);
        else if (msg.t === 'update-health') done(null, msg);
        else if (msg.t === 'auth-fail' || msg.t === 'error')
          done(new Error('Companion refused the updater request'));
      } catch {
        done(new Error('Invalid companion health response'));
      }
    };
  });
}
