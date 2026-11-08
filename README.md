# Sarvesh Illam

A local home dashboard for two CP Plus DVRs (Dahua OEM), 4 cameras each, and
Home Assistant-connected devices. It pulls RTSP off the DVRs with
[go2rtc](https://github.com/AlexxIT/go2rtc) and restreams to the browser over
WebRTC/MSE — no cloud or vendor app required for camera viewing.

The stock mobile app (gCMOB) only reaches the cameras through a proprietary P2P
relay, which is unusable for desktop viewing or automation. Local RTSP is the
way in.

## Layout

| File | Purpose |
| --- | --- |
| `go2rtc.yaml` | Stream definitions. Credentials come from the environment. |
| `www/` | Sarvesh Illam dashboard, served by go2rtc at `http://<LAN_IP>:1984/`. |
| `run.sh` | Shortcut for `./stack.sh start dashboard home`. |
| `alerts/` | Camera alerts plus the Home Assistant control bridge. |
| `home-assistant/` | Safe, optional camera-triggered-light automation template. |
| `android/` | Capacitor Android project for the Sarvesh Illam APK. |
| `.env.example` | Template for `.env`. |
| `cctv.m3u` | Jellyfin Live TV playlist (optional). |

`www/video-stream.js` and `www/video-rtc.js` are vendored from go2rtc v1.9.14 —
setting `api.static_dir` replaces go2rtc's embedded web assets, so the player
component must be shipped alongside the dashboard. If you upgrade the go2rtc
binary, re-vendor both files from the matching tag.

## Start the services

Docker Compose keeps every capability independent. The dashboard never
requires CCTV, alerts, or Home Assistant to be running.

On macOS, `stack.sh` runs the small `home` network bridge directly on the host
because Docker Desktop cannot forward the Smarteefi LAN broadcast protocol.
All other services remain isolated containers. Linux uses the `home` container.

Start only the useful default—dashboard plus local home-device control:

```sh
./stack.sh start
```

Open `http://<LAN_IP>:1984/` from any device on the LAN. Start or stop optional
services whenever needed:

```sh
./stack.sh start cctv
./stack.sh start alerts
./stack.sh start homeassistant

./stack.sh stop cctv
./stack.sh stop alerts
./stack.sh stop homeassistant

./stack.sh status
./stack.sh logs home
./stack.sh down
```

`./stack.sh start all` starts everything. `./run.sh` remains as a shortcut for
`dashboard + home`. Stopping a service does not delete its data.

The Home tab controls configured local devices even when every camera and Home
Assistant are offline. The Security tab shows unavailable cameras as offline.
Phones get a scrollable column layout with swipe
navigation in the focus view, and "Add to Home Screen" installs it as a
full-screen app. The page also still works opened directly as a `file://` on
the host machine.

### Optional CCTV configuration

Copy `.env.example` to `.env` and fill in the DVR credentials and addresses
only when the `cctv` service is needed. Create a dedicated stream user on each
DVR; do not reuse the admin login.

Give the host machine a fixed address (DHCP reservation on the router, or a
manual IP) — it's baked into `LAN_IP` and into every device's bookmark.
If another LAN device cannot open the dashboard, allow incoming connections for
go2rtc (TCP port 1984) in the Mac firewall; never forward this port to the
internet.

## How it works

go2rtc pulls each camera from the DVR **once** and fans it out to every viewer,
so ten browser tabs still cost the DVR a single RTSP connection. It relays H.264
packets without transcoding, so the host machine does almost no work — it's
copying bytes, not re-encoding.

Each camera exposes two streams:

- **main** (`camN`) — 1280×720, used for the single-camera focus view
- **sub** (`camN_sub`) — 352×288, used for the multiview grid

### The DVR is the bottleneck, not the host

A DVR is a cheap embedded box whose real job is recording 4 channels to disk
24/7; serving live RTSP is a side gig it does with leftover CPU and NIC headroom,
and its firmware caps concurrent sessions. Four simultaneous **main** streams
from one DVR causes `i/o timeout` drops.

So the grid uses sub-streams and only the focus view upgrades to main. This limit
is **per-DVR** — each unit has its own CPU, NIC, and session cap, so a second DVR
adds capacity rather than competing for it. All 8 sub-streams (4 per DVR) run
concurrently without drops. The rule in practice: don't open several HD focus
views against the *same* DVR at once.

## Networking notes

Pin each DVR's address static **on the DVR itself** (Main Menu → Network →
TCP/IP). A router DHCP reservation is unreliable here: these units present a
**different MAC address on each reboot**, so the reservation won't match.

When hunting for a DVR on the network:

```sh
nmap -p 554,80,8000,37777 --open -n -T4 192.168.0.0/24
```

Identify each hit with an unauthenticated RTSP `OPTIONS` — the 401 response
names the exact unit in its auth realm, which is the only reliable way to tell
two DVRs apart (a single DVR can answer on more than one IP if it's holding a
stale DHCP lease alongside its static address):

```sh
printf 'OPTIONS rtsp://HOST:554/ RTSP/1.0\r\nCSeq: 1\r\n\r\n' | nc -w 4 HOST 554
# RTSP/1.0 401 Unauthorized
# WWW-Authenticate: Digest realm="Login to <SERIAL>", ...
```

RTSP URLs follow the Dahua scheme and require **Digest** auth:

```
rtsp://<user>:<pass>@<host>:554/cam/realmonitor?channel=<N>&subtype=<0|1>
```

## Security

`.env` is gitignored and holds the only copy of the credentials. `go2rtc.yaml`
references them as `${VAR}`, which go2rtc expands from the environment at
startup — and values sourced this way are masked as `***` in its HTTP API.

`api.origin: "*"` in `go2rtc.yaml` is required for the `file://` dashboard to
embed feeds cross-origin. It makes the API accessible from any page you visit
while go2rtc is running, which is an acceptable trade on a trusted LAN — but
don't expose port 1984 to the internet.

For remote access, join the home network over Tailscale and open the dashboard
at the server's Tailscale address instead of forwarding any port. The cameras,
DVRs, and smart devices stay on the LAN; only the Tailscale-connected device
reaches them.

## Alerts service

`alerts/` is a Python service (managed with [uv](https://docs.astral.sh/uv/))
that watches every camera through go2rtc's local RTSP server — the DVRs see no
extra connections — and pushes alerts to Telegram plus an event feed the
dashboard shows in its bell menu.

```sh
./stack.sh start cctv alerts
./stack.sh logs alerts
```

What it detects today:

- **Person** — YOLO11n over every camera (~1.4 passes/s, all 8 batched in
  ~50 ms). Two consecutive hits required, 60 s per-camera cooldown, snapshot
  with boxes attached to the alert. Mute individual cameras with
  `person_alerts: false`.
- **Rider on two-wheeler** (parking camera) — person + motorcycle overlap.
  Dashboard-only for now; each sighting archives an HD frame under
  `alerts/dataset/riders/`. That archive is the training set for a helmet
  classifier fine-tuned on this exact camera view — chosen over loading
  third-party `.pt` weights, which are pickles that execute arbitrary code
  on load and whose provenance we couldn't verify.
- **Camera down** — no frames for 30 s (with recovery notice)
- **Image black / camera covered** — brightness or sharpness collapsing
  against that camera's *own* per-mode baseline. Absolute thresholds don't
  work here: a camera whose IR floods the scene sits at luma ~130 at night
  while one facing an unlit yard legitimately sits at ~2, so "dark" is only
  meaningful relative to what each camera normally sees.
- **Day/night (IR) tracking** — each camera's IR switch is detected from
  frame saturation (with hysteresis and a grace window), thresholds adapt,
  and the dashboard shows a 🌙 on night-mode tiles.

Camera access is optional at runtime. Each unreachable camera gets three
bounded connection attempts, is then shown as offline, and retries quietly
every five minutes. The dashboard and smart-home API remain available during
that entire process. Selecting the Home tab tears down browser camera players,
and the last selected tab is restored on the next visit. Person detection is
not loaded until at least one camera has delivered a frame.

### Telegram setup

1. Message **@BotFather** on Telegram → `/newbot` → copy the token.
2. Message your new bot once (anything), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy
   `message.chat.id` from the response.
3. Add both to `.env`:

```sh
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
```

Without these the service still runs — events just stay local (log + dashboard).

## Home Assistant / smart home

The Home tab is provider-based. Home Assistant remains the general integration
layer for supported lights, switches, and sensors, while LAN-only adapters can
feed the same dashboard without cloud credentials. Every house runs its own
alerts service on its LAN; house-specific device identities belong in the
ignored `alerts/config.local.yaml` file.

### Smarteefi SE51 strips

Smarteefi strips use a broadcast-only local protocol, so the adapter must run
on the same LAN as the strip. It does not require the Smarteefi app, cloud
account, password, API token, or activation code.

```sh
cp alerts/config.local.example.yaml alerts/config.local.yaml
```

Edit the copied file with the strip's serial, current IP, subnet broadcast,
room, and outlet names. Restart `./stack.sh restart home`; the five outlets appear as
ordinary switches on the Home tab. Add another item under `strips` for each
additional strip on that house's network. Deploy the same repository and a
different ignored local config at another house—never commit one house's
device inventory as shared configuration.

The IP is used to reject replies from the wrong host; commands themselves are
sent to the subnet broadcast address because tested SE51 firmware does not
answer unicast packets. Reserve the strip IP in the router when possible.

### Home Assistant devices

Sarvesh Illam keeps Home Assistant's long-lived token on the local home
service; it is never placed in the dashboard or Android app. Connect devices
in Home Assistant, set their entity IDs in `alerts/config.yaml`, and add the
Home Assistant URL/token to `.env`:

```sh
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=replace-with-a-long-lived-token
```

Restart `./stack.sh restart home`. The Home tab will then expose only those configured
devices. WiZ lights support on/off, brightness, colour temperature, RGB colour,
and their available effects; switches and configured sensor readings appear in
the same room card. Philips Smart Wi-Fi bulbs sold in India generally use WiZ and should
be enabled for local communication in the WiZ app. Verify the exact Wipro plug
model/account pairing before enabling it; some models require the Tuya cloud
integration.

Use **+ Room** and **+ Device** on the Home tab to organise the dashboard
without editing YAML. Each room has a **Turn off room** action for its configured
lights and switches, while each device can be renamed, moved, re-iconed, or
removed from the dashboard (removing it never deletes it from Home Assistant).
These shared layout choices are saved locally in `data/home/home-layout.json`,
which is intentionally untracked because it is household-specific.

### Music-reactive lighting

The Home tab has a **Music reactive** control that uses the microphone of one
dashboard or app to drive the configured WiZ light. It works with any nearby
audio source and does not need Spotify credentials. The browser asks for
microphone permission only while the mode is running; no audio is uploaded or
stored.

Only one device can be the source at a time. Other open dashboards show the
current source and can stop it or take over. The home service owns all Home
Assistant writes and automatically releases a source that stops checking in
after 12 seconds. Configure the controlled dashboard light in
`alerts/config.yaml` under `music_reactive.light_id`.

`home-assistant/automations.yaml` is an opt-in, conservative example that turns
on a light after a night-time person alert. It never controls the smart plug.

Run the local Home Assistant server and connect the two devices using the full
guide in [`home-assistant/SETUP.md`](home-assistant/SETUP.md). It runs in Docker
but Sarvesh Illam remains the daily dashboard; Home Assistant is the local
automation engine behind it.

## Android APK

The `android/` Capacitor project packages the same dashboard. See
[`android/README.md`](android/README.md) to build and sign a release APK.
On first launch, tap the server address beside the Sarvesh Illam title and set
the LAN dashboard address.

## Status

Both DVRs live, 8 cameras on the LAN dashboard; camera-health, person, and
rider detection running. The Home tab supports Home Assistant devices and
local Smarteefi SE51 outlets through the same room/device interface, with
shared music-reactive lighting available for the configured Home Assistant
light.

Planned: helmet classifier fine-tuned on the collected rider dataset (then
no-helmet Telegram alerts), Android microphone permission for music-reactive
lighting, launchd agents for go2rtc + alerts.
