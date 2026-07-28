# Android TV prototype

This branch contains an end-to-end Android TV adapter prototype. Telex and Codex
still run on the server. The TV is a thin authenticated client: it lists the
owner's durable Codex tasks, opens their message history, sends messages, streams
progress and final answers, and renders interactive approval choices.

The prototype is intentionally opt-in and is not part of a Telex release.

## Architecture

```text
Android TV app
  ├─ HTTPS REST: pairing, task list/history, messages, choices
  └─ HTTPS SSE: progress, answer deltas, approvals, notifications
                  │
                  ▼
          AndroidTvChannel
                  │ MessagingChannel
                  ▼
            CodexBridge
                  │
                  ▼
          Codex app-server

Private Telegram chat
  └─ /pair 12345678 ──► one-time pairing service ──► device token
```

Pairing creates a random 192-bit challenge ID plus an 8-digit, 10-minute code.
Only an already allowlisted user can approve it, and approval is accepted in a
private bot chat only. The TV receives a random 256-bit bearer token. Telex
persists only its SHA-256 hash in `android-tv-devices.json`; the APK stores the
token in its private, non-backed-up application preferences.

An approved challenge can return the same token again until the TV proves that
it saved the token by making its first authenticated request. Telex then
consumes the challenge. This avoids permanently stranding a TV if the first
poll response is lost while keeping the challenge short-lived.

A paired device inherits its approver's task scope. The API derives the visible
thread IDs from Telex's durable conversation mappings for that provider user.
It does not expose the app-server's global thread list, so two allowed Telegram
users cannot browse each other's tasks. Selecting a Telegram-created task on TV
resumes that same Codex thread under the TV conversation.

SSE connections carry monotonic event IDs and can replay the latest 100 events
after a short disconnect. Interactive Codex questions and approvals are emitted
as choice events and completed through an authenticated response endpoint.
Scheduled-run delivery uses the same `MessagingChannel` target abstraction.

## Why this Android stack

The app is native Kotlin, targets API 35, and supports API 21 and newer. It uses
platform Views, `HttpURLConnection`, and `org.json` with no WebView, Google Play
Services, React Native, Flutter, or third-party runtime dependencies.

Google recommends Compose for TV and has deprecated the Leanback UI toolkit.
This prototype deliberately uses neither: the UI is still exploratory, while
plain Views give us a small APK, explicit D-pad focus behavior, low startup and
memory overhead, and the broadest chance of working on low-cost AOSP-based TVs
without Google components. After the product flow is settled, Compose for TV can
be evaluated on representative low-end hardware rather than adopted on faith.

The manifest:

- exposes both `LEANBACK_LAUNCHER` and ordinary `LAUNCHER` entries, so AOSP boxes
  with incomplete Leanback support can still launch it;
- declares touchscreen, fake touch, and Wi-Fi as optional;
- works with the minimum D-pad controls;
- requires HTTPS in release builds (debug builds allow HTTP for isolated tests);
- has no camera, microphone, location, storage, or account permissions.

Relevant Android guidance:

- <https://developer.android.com/training/tv/get-started/create>
- <https://developer.android.com/training/tv/get-started/controllers>
- <https://developer.android.com/training/tv/get-started/hardware>

## Run the prototype

On the Telex server, set:

```dotenv
ANDROID_TV_ENABLED=true
PUBLIC_URL=https://telex.example.com
```

`PUBLIC_URL` should be a stable HTTPS origin reverse-proxied to Telex's normal
`HOST`/`PORT`. A TryCloudflare quick tunnel also exposes the TV API, but its URL
changes on restart and is not a suitable saved TV address.

Build the debug APK in a disposable rootless Docker environment:

```sh
DOCKER_HOST=unix:///run/user/999/docker.sock \
  ./scripts/validate-android-tv-container.sh \
  --output /tmp/telex-tv-debug.apk
```

The script copies only `android-tv/` into temporary Docker volumes, verifies
the pinned Gradle and Android command-line archives, installs SDK 35, warms the
dependency cache with network access, then repeats clean lint, unit tests, and
APK assembly with networking disabled. It removes all containers and volumes.

Install the APK through ADB or your TV's normal sideload mechanism. On first
launch:

1. Enter the Telex HTTPS origin once.
2. The TV shows an 8-digit code.
3. Send the displayed `/pair CODE` command in the private Telex Telegram chat.
4. The TV opens the task list automatically.

For lab provisioning, the server URL can be injected without typing:

```sh
adb shell am start \
  -a android.intent.action.VIEW \
  -d 'telex://connect?server=https%3A%2F%2Ftelex.example.com'
```

## Current prototype boundaries

- Pairing approval currently uses Telegram because it is the trusted adapter in
  `main`. The pairing command interface is provider-neutral, so Slack can expose
  the same private/admin approval after its open PR lands.
- There is no central rendezvous service. A generic store-installed app cannot
  discover an arbitrary remote self-hosted server without either entering the
  origin, receiving a provisioning deep link, using same-LAN discovery, or
  trusting a hosted broker. This prototype chooses one-time origin entry and no
  central dependency.
- The UI is a functional 10-foot/D-pad shell, not the final visual design.
- **Disconnect** revokes the current device token on the server. A server-side
  admin view for naming and revoking other TVs is still a follow-up.
- The debug APK uses the normal Android debug key. A real distribution needs a
  stable release signing key and an explicit update channel.

## Test coverage

`test/android-tv.test.ts` starts a real HTTP server and proves:

- pairing challenge creation and private-owner approval;
- one-time token delivery and hashed persistence;
- authenticated, owner-scoped task listing;
- task activation and message submission;
- SSE progress and answer deltas;
- interactive choice delivery and response;
- unauthenticated request rejection.

`test/android-tv-bridge.test.ts` proves both `/pair CODE` and Telegram's
`/start tv_CODE` deep-link form, including the private-chat gate.
