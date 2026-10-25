# 17 — Remote access

Watch and type into your TabTerm terminals from a phone, a tablet or another computer, in an
ordinary browser. There is no app to install and no account to create. It is off until you turn it
on, and it goes through a relay you run yourself on Cloudflare's free plan.

---

## 1. What it can and cannot do

| A paired device can | A paired device cannot |
|---|---|
| See every running terminal, grouped the way the Mac's tabs are | End or kill a session |
| Open one and see what is on it, with its recent history | Open anything on the Mac, a tab or a page |
| Follow its output live | Change a terminal's size |
| Type into it, unless typing is turned off for that device | Touch a setting, a plugin or a layout |
| See that an agent is asking for something | Read a file, or anything that is not a terminal |

The right-hand column is not a list of switches. The daemon has no message a browser can send that
does any of those things, so there is nothing to turn off. See `daemon/src/remote/bridge.ts`.

**Nothing changes on the Mac.** A device watching a terminal is not one of its views. It listens
to the same output the history archive listens to, so it does not take part in choosing the
terminal's size, does not count as a tab holding it, and does not affect when a terminal in the
background is ended. Typing from a device reaches the shell exactly as typing on the Mac does,
and both see the result.

---

## 2. How it fits together

```
 Mac                               Your relay (Cloudflare, free)          Phone or laptop
 ──────────────────────────        ─────────────────────────────          ────────────────
 tabtermd ── one outgoing ──────►  passes sealed bytes it      ◄────────  the page it serves,
            connection             cannot open                            in any browser
```

- **The daemon connects out.** It opens no port and listens on nothing new. "Nothing binds off
  loopback" in `05-security.md` stays true
- **The relay** is `relay/worker.js`, a Cloudflare Worker with one Durable Object per Mac. It
  serves the page and passes frames between the Mac and its devices. It holds no keys and stores
  nothing but a connection counter. An idle relay uses no resources (hibernation)
- **The page** is `relay/page.html`, built from `relay/page/` by `npm run build:relay`. One file,
  with every script inside it, and served with a policy that lets it run only that script, by its
  hash, and load nothing from anywhere else

**Cost on the Mac.** Off, it reads one small file at start and does nothing else. On, it is one
WebSocket and the frames passing through it, inside the daemon that is already running: no new
process. Measured with a device paired and watching, the daemon's memory did not measurably change.

---

## 3. Security

### Encrypted end to end

Pairing makes a 32 byte key on the Mac for that device. It reaches the device inside the pairing
link's `#fragment`, and a browser never sends a fragment to any server, so the relay never sees it.
The device keeps it in IndexedDB as a WebCrypto key that cannot be read back out.

Every connection derives two fresh AES-GCM keys from it with HKDF, one per direction, salted with a
random nonce from each side, so a recorded connection cannot be replayed into a new one. Every
frame carries a counter that must only go up, so a frame cannot be replayed within one either. See
`shared/src/remote.ts`.

What the relay can see: that a device connected, when, and how many bytes went each way.

### Unlocked by the device's owner, every time

A key on a phone somebody else picks up is still a key. So pairing also makes a **passkey** on the
device, and the device will only use it after Face ID, Touch ID or its passcode. Every connection
asks it to sign a fresh challenge, and the daemon checks the signature against the public key it
kept at pairing (`daemon/src/remote/webauthn.ts`). The daemon requires user verification, the
right site and origin, a fresh challenge, and a signature counter that never goes backwards.

There is no account. The list of trusted devices is a file on the Mac,
`~/.local/state/tabterm/remote.json`, readable by you only.

### Pairing

A pairing link works **once, for ten minutes**. The code is shown only in Settings on the Mac,
which only somebody at the Mac can see. Anyone who has the code within those ten minutes can pair,
so it is for showing to your own device only.

### Other limits

- **The relay secret** makes sure only your Mac can take the Mac's place on the relay. It is set on
  the relay once and entered in Settings once, stored in the same `0600` file, and never sent back
  to the page
- **Failed unlocks** are counted per device: five, and that device is refused for five minutes
- **A device that has not unlocked within a minute** is let go
- **A device out of sight** for two minutes closes its connection, so the next look unlocks again
- **Removing a device** in Settings cuts its open connections at once
- **A slow device cannot slow the Mac.** Output is never held back for it. A device that falls too
  far behind stops being sent output and is sent the whole screen once it catches up
- The relay refuses frames over 1 MB and more than eight devices at once per Mac

### What this changes in the threat model

Turned on, terminals can be read and typed into from outside the Mac by a device that holds both
a paired key and its passkey. That is the feature. Somebody who controls your relay or your
Cloudflare account gets no terminal content, because they have no key, and cannot pose as your Mac
to your devices, because they cannot seal anything a device will open. Losing a device is handled
by removing it in Settings, and until then by its own Face ID or passcode.

---

## 4. Setting it up

About five minutes, once. Everything is free and needs no card.

### 1. A Cloudflare account

Sign up at <https://dash.cloudflare.com/sign-up> if you do not have one. Workers and Durable
Objects are on the free plan.

### 2. Deploy the relay

From the repository, in a terminal:

```
cd relay
npx wrangler login                 # opens your browser once to allow it
npx wrangler deploy                # prints your relay's address, https://tabterm-relay.<you>.workers.dev
openssl rand -base64 33 | tr -d '\n' | tee /dev/stderr | npx wrangler secret put RELAY_SECRET
```

The last line makes a random secret, prints it so you can copy it, and stores it on the relay.

**If deploy says "You need a workers.dev subdomain" (code 10063).** A new account has none until
the Workers page in the dashboard is opened once. Open <https://dash.cloudflare.com>, then
**Workers & Pages**, and run `npx wrangler deploy` again. A brand new address can take a few
minutes before it answers over https.

`npx` fetches wrangler for the moment it runs and keeps nothing in the repository. The relay can be
redeployed the same way after an update; your devices stay paired.

### 3. Turn it on

In TabTerm, open **Settings**, then **Remote access**. Paste the relay's address and the secret,
press **Save relay**, and turn **Remote access** on. The status line says **Connected to your
relay**.

### 4. Add a device

Press **Show a pairing code**.

- **A phone or tablet:** point its camera at the code and open the link
- **Another computer:** press **Copy link** and open it there

The page asks to **Trust this device**, which makes the passkey: Face ID, Touch ID or the passcode.

**On an iPhone, as an app on the Home Screen.** An app added to the Home Screen keeps its own
storage, apart from Safari's, so it is paired on its own:

1. Open your relay's address in Safari, then Share, **Add to Home Screen**
2. Open TabTerm from the Home Screen. It says it is not paired yet and offers a box for a link
3. On the Mac, press **Show a pairing code**, then **Copy link**. Universal Clipboard carries it to
   the iPhone. Paste it in the box and press **Pair**

From then on, opening the page asks to **Unlock**, and shows your terminals.

### Managing devices

Settings, Remote access lists every trusted device with when it was added and last used.

- **Can type** off makes it watch only. Its key bar goes away at once
- **Remove** cuts it off at once and forgets it. It can be paired again with a new code

Turning **Remote access** off closes every connection and makes none until it is turned on again.
Devices stay paired.

---

## 5. Testing

- `daemon/src/remote/*.test.ts`: the relay's real code run in Node (`test/remote/relay-shim.mjs`),
  the real bridge and store, and a browser played by the test with a software passkey. Pairing,
  unlocking, a wrong passkey, a stranger, a spent link, watch-only devices, removal, and that no
  message a browser can send ends, opens or resizes anything
- `test/remote/e2e.mjs`: a daemon of its own, the real page in headless Chrome at phone size, and
  Chrome's virtual authenticator for Face ID. A desktop view stays attached at 120 by 40 throughout
  and the run fails if anything the phone does changes that size. Run it with
  `node test/remote/e2e.mjs`
