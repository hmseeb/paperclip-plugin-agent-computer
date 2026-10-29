# The agent computer

OpenBot's agent computer (github.com/CopilotKit/openbot, `agent-computer/`, MIT), built from source
at `cd161d048dd01d1e3d84ec847587639eceaa9715` with `human-browser.patch`, which adds the browser
chrome a person driving it needs:

- `GET /tabs`: the open tabs and which one is shown.
- `POST /human/navigate {url}`, `POST /human/history {action: back|forward|reload}`,
  `POST /human/tabs {action: select|new|close, index}`: only while a person holds the browser.
- A tab the person switches to stays the live one until it closes or the site opens a new window.
- Each browser gets its own egress-filter port instead of proxy credentials: with credentials,
  Chromium stalled on Google (search never loaded); the port identifies the agent instead.
- No passkeys (WebAuthn reports unsupported in every page and popup). A passkey prompt is Chromium's
  own window, which never reaches the live screen, so "Sign in with Google" sat on "Verifying it's
  you…" with nothing to click. Sites fall back to password and codes, which happen in the page.
- Upstream proxies set at runtime per browser (`PUT /egress-policy {policy, upstream}`), winning over
  `EGRESS_PROXY_*`; `null` is direct. The plugin sends each computer's proxy with every policy push.
- `SCREENCAST_QUALITY` sets the live screen's JPEG quality (default 70; 40 suits a home upload).

The pinned commit is in `OPENBOT_REF`. CI builds the image as `ghcr.io/hmseeb/agent-computer` for amd64
and arm64 (`.github/workflows/images.yml`); `.github/workflows/test.yml` checks the patch still applies.
