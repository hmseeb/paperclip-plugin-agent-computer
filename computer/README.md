# The agent computer

OpenBot's agent computer (github.com/CopilotKit/openbot, `agent-computer/`, MIT), built from source
at `cd161d048dd01d1e3d84ec847587639eceaa9715` with `human-browser.patch`, which adds the browser
chrome a person driving it needs:

- `GET /tabs`: the open tabs and which one is shown.
- `POST /human/navigate {url}`, `POST /human/history {action: back|forward|reload}`,
  `POST /human/tabs {action: select|new|close, index}`: only while a person holds the browser.
- A tab the person switches to stays the live one until it closes or the site opens a new window.

On Greg's mini the source and patch live in `~/paperclip/agent-computer/`, and `compose.yml` runs the
image `agent-computer:cd161d0-human1` plus `agent-computer-gateway` (`../gateway/gateway.ts`).
