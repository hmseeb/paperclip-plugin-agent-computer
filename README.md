# paperclip-plugin-agent-computer

A computer for every [Paperclip](https://github.com/paperclipai/paperclip) agent: a real Chrome that
keeps its logins between runs. People watch it live from Paperclip and take over when an agent asks
for help (a login, 2FA, a captcha, a step it doesn't know). Agents learn from what people do while
they hold the computer.

## What it does

- **A computer per agent.** Each agent opens, reads, clicks, types and scrolls in its own browser,
  and stays logged in between runs. Agents get a skill that tells them how.
- **Computers page and corner card.** Every agent's screen live, with an address bar, back, forward,
  reload and tabs. A small live card appears in the corner of any Paperclip page when an agent needs a
  person, or while you chat with an agent that is using its computer. Click it to open it full size.
- **Take over and hand back.** Full mouse and keyboard while you hold it (hover, drag, double-click,
  shortcuts, paste). Handing back is how you say you're done; the agent carries on by itself.
  A computer someone walked away from goes back to its agent after 5 minutes nobody is watching.
- **Passwords the agent never sees.** An agent points at a field and asks; you type the password
  into the field from Paperclip.
- **Learning by showing.** Whatever you do while holding a computer (what you clicked, which fields
  you typed in, never what you typed) goes to the agent, which saves it as a how-to and follows it
  next time. Corrections update it, and an agent can teach another agent.
- **Shared computers.** Named computers several agents use, one at a time, such as one logged into
  GoHighLevel for everyone. For all agents by default, or only the ones you pick.
- **Proxies.** Send the computers' traffic through proxies (residential ones, for example), tested
  before saving, per agent or shared computer. Choose what happens when one stops working: keep
  working over the computer's own connection, or stop.
- **Limits per agent.** Restrict an agent to a list of sites.
- **Mattermost.** With the [Mattermost plugin](https://github.com/hmseeb/paperclip-plugin-mattermost),
  help requests are also posted in the thread the agent is working in, with a Take over link, and a
  message you send there while it waits reaches it.

## How it fits together

```
agents ──(plugin routes)──▶ Paperclip + this plugin ──(token)──▶ agent-computer   (Chrome per agent)
people ──(Computers page)──▶ Paperclip + this plugin
people's browsers ──(signed 60-second link)──▶ agent-computer-gateway ──(token)──▶ agent-computer
```

- **agent-computer** is OpenBot's agent computer (MIT), built with a small patch (see NOTICE).
  It is never reachable from the internet; only the plugin and the gateway talk to it, with its token.
- **agent-computer-gateway** serves the live screen: it checks short-lived links the plugin signs and
  shares one stream per computer between everyone watching.

## Requirements

- Paperclip 2026.1023.0 (commit 1b4c803). Other versions mostly work; the plugin says so in its
  settings when the server runs a different one.
- Docker on the server that runs Paperclip, and about 3 GB of memory for the computer (a Chrome per
  agent in use; at most 8 run at once, and idle ones close after 30 minutes, keeping their logins).
- People's browsers must reach the gateway: a path on Paperclip's own address, or its own address.

## Install

1. **Run the computer and the gateway** next to Paperclip, on the same Docker network. Add the two
   services in [`deploy/docker-compose.yml`](deploy/docker-compose.yml) to the compose project that runs
   Paperclip, and make the token file it describes.
2. **Make the live screen reachable.** Either:
   - route `/_computer/` on your Paperclip address to the gateway (recommended: same address, no
     extra certificate). Cloudflare Tunnel (`config.yml`):
     ```yaml
     ingress:
       - path: ^/_computer/
         service: http://agent-computer-gateway:4200
       - service: http://paperclip:3100
     ```
     Caddy: `handle /_computer/* { reverse_proxy agent-computer-gateway:4200 }` before Paperclip's
     `reverse_proxy`. nginx: a `location /_computer/` block with `proxy_pass
     http://agent-computer-gateway:4200;` and the websocket upgrade headers.
   - or publish the gateway on its own address (e.g. `https://computer.example.com`) and put that in
     the plugin's **Live screen address** setting.
3. **Install the plugin** in Paperclip: `paperclip-plugin-agent-computer`.
4. **Per company,** in the plugin's settings:
   - **Computer URL:** `http://agent-computer:4100`.
   - **Computer token:** a Paperclip secret holding the same `COMPUTER_TOKEN`.
   - **Save.** Saving installs the "Agent computer" skill and gives it to every agent. Save again after
     hiring agents, so new ones get it too.

Several companies can share one computer; each needs the token secret in its own settings.

**On Railway,** the "Paperclip with Agent Computer" template runs all of this and serves the live screen
on Paperclip's own address. In the plugin settings use Computer URL
`http://agent-computer.railway.internal:4100`, and for the token a Paperclip secret holding the
`agent-computer` service's `COMPUTER_TOKEN` variable.

## Using it

- **Computers** in the sidebar: every agent and shared computer, a "Needs you" tag on the ones
  waiting, the live screen, and each agent's learned how-tos.
- **Typing in the address bar** searches Google unless it looks like an address. New tabs open Google.
- **Agents** call plugin routes under `/api/plugins/agent-computer/api/pc/` with their own Paperclip
  credentials: open, look, click, type, key, scroll, read, screenshot, ask-for-help, ask-for-password,
  wait, cancel-help, how-tos, shared computers. `GET /pc/help` explains them; the skill teaches them.

## Security

- **Agents only drive their own computer** (or a shared one they may use). Paperclip tells the plugin
  which agent is calling; the computer's token never leaves the server.
- **The Computers page and corner card are for people.** Calls an agent makes to them are refused.
- **The live screen** needs a link the plugin signs for one computer, used once, valid for 60
  seconds, and "view only" for the corner card. The computer itself refuses input unless a person holds
  it. The gateway's other endpoints (recorded steps, who is watching) are on a second port, 4201, that
  only the plugin uses: never route it from outside.
- **No private network.** Agents' browsers can't reach loopback or private addresses (the admin pages
  and databases next to the computer) or cloud metadata addresses. Set `EGRESS_BLOCK_PRIVATE=off` on the
  computer only if agents really need an internal site.
- **Password prompts** only go to password or one-time-code fields, and name the site asking.
- **How-tos one agent teaches another** never replace what that agent already knows.
- **Passwords** typed for an agent go into the page field and are not stored, logged, returned or
  shown to the agent. Recorded steps never include what was typed.
- **Proxies** are kept as Paperclip secrets and only sent to the computer.
- **Treat the computer token like a password.** Anyone holding it can drive every computer, with its
  saved logins. Rotate it in both places (the token file and the Paperclip secret) if it leaks.
- **Not for Paperclip's `local_trusted` mode.** There every local request counts as the board, so a
  process on the same machine (an agent's shell, for example) passes the "people only" checks.
- **Inside the computer container,** each browser's local proxy port needs no password, so a program
  running in that container could go out as any browser. The plugin never runs programs there (it
  doesn't expose the computer's shell); keep it that way if you use the computer for anything else.

## Limits

- **A screencast, not video.** About 5 frames a second over a typical home upload; a click shows
  after one round trip between you and the server.
- **Browser-drawn windows don't appear:** "Save password?", file pickers, permission prompts.
  Passkeys are switched off for that reason, so sites offer passwords and codes instead.
- **Agents decide what to save as how-tos.** The plugin hands them your steps and tells them to;
  saving is up to them.
- **The plugin can't stop an agent's run.** A "stop" sent in Mattermost is read at its next step.

## Development

```bash
npm install
node build.mjs           # builds against the Paperclip SDK source at PAPERCLIP_REF (default 1b4c803)
npm test
```

The computer: `computer/human-browser.patch` applies to OpenBot at `computer/OPENBOT_REF`
(`git apply`, then `docker build -f agent-computer/Dockerfile .` in OpenBot's checkout).
The gateway: `gateway/gateway.ts`, run with Bun.

## Releasing

Bump `version` in `package.json` and `src/manifest.ts`, commit, then tag and push:

```bash
git tag -a v0.7.1 -m v0.7.1 && git push origin main v0.7.1
```

The tag publishes the plugin to npm and builds both images for amd64 and arm64 on GHCR.

## Credits

Built on [OpenBot](https://github.com/CopilotKit/openbot) by CopilotKit (MIT): the agent computer, and
the live-screen code ported in `src/ui/live-screen.tsx`. See [NOTICE](NOTICE).

## License

MIT
