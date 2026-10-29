// The "Agent computer" skill, installed in each company's library and given to agents on save.
export const HELP = `# Your computer

You have your own browser on an agent computer: a real Chromium that keeps your logins between
runs. Nobody else's agent uses it. People can watch it live from the Computers page in Paperclip
and take over when you ask. Use it for websites that have no API or that need you to be logged in.
Each call is a plugin route; call them with your Paperclip API credentials:

  B="\${PAPERCLIP_API_URL%/}"; B="\${B%/api}/api/plugins/agent-computer/api/pc"
  H=(-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "content-type: application/json")
  curl -s "\${H[@]}" -d '{"url":"https://example.com"}' "$B/open"
  curl -s "\${H[@]}" -X POST "$B/look"

## How to work

1. **open** a URL. The answer has the page title and its readable text.
2. **look** before acting: it lists what you can act on, each with a \`ref\`, plus a \`snapshotId\`.
3. **click** or **type** with that \`ref\` and \`snapshotId\`. After the page changes, look again:
   old refs stop working (you get a 409 saying so).
4. **read** returns the page's text again; **screenshot** returns a PNG as base64 when the layout
   matters: \`curl -s "\${H[@]}" "$B/screenshot" | jq -r .base64 | base64 -d > /tmp/page.png\`, then view it.

## When you need a person

- **A login, captcha, 2FA prompt or anything you should not or cannot do yourself:** call
  **ask-for-help** with a short reason. A person is notified and takes over the browser. Until they
  hand it back, your actions get a 409. Check **status** now and then; when \`holder\` is \`bot\` again,
  look again before acting.
- **A password or secret for a field:** look, then call **ask-for-password** with the field's
  \`ref\`, \`snapshotId\` and a \`label\` ("GoHighLevel password"). A person types it straight into the
  field; you never see it and must never ask for it in chat.
- Never type passwords, card numbers or codes you were given in chat into a page yourself.

## Calls

GET  /status                     who has the browser (\`holder\`: bot or human), pending requests
POST /open        {"url"}
POST /look        {}
POST /click       {"ref","snapshotId"}
POST /type        {"ref","snapshotId","text","submit":false}
POST /key         {"key":"Enter"}  optionally with "ref","snapshotId" to press it in a field
POST /scroll      {"deltaY":600}   negative scrolls up
GET  /read
GET  /screenshot
POST /ask-for-help      {"reason":"Log in to GoHighLevel, I hit 2FA"}
POST /ask-for-password  {"ref","snapshotId","label"}

A site outside the ones you are allowed fails to load; say so rather than looking for a way round.
`;

export const SKILL = `---
name: agent-computer
description: >
  Use when a task needs a real web browser: open and read websites, click and type, stay logged
  in between runs, and hand the browser to a person for logins, captchas, 2FA or passwords.
---

${HELP}`;
