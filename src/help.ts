// The "Agent computer" skill, installed in each company's library and given to agents on save.
export const HELP = `# Your computer

You have your own computer for the web: it opens websites in Chrome and keeps your logins between
runs. People can watch it live on the Computers page in Paperclip and take over when you ask. Use it
for websites that have no API or that need you to be logged in. Each call is a plugin route; call
them with your Paperclip API credentials:

  B="\${PAPERCLIP_API_URL%/}"; B="\${B%/api}/api/plugins/agent-computer/api/pc"
  H=(-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "content-type: application/json")
  curl -s "\${H[@]}" -d '{"url":"https://example.com"}' "$B/open"
  curl -s "\${H[@]}" -X POST "$B/look"

## How to work

1. **Check your how-tos first** (GET /howtos). If one fits the task, follow its steps yourself;
   a person already showed you how. Do not ask them again.
2. **open** a URL. The answer has the page title and its readable text.
3. **look** before acting: it lists what you can act on, each with a \`ref\`, plus a \`snapshotId\`.
4. **click** or **type** with that \`ref\` and \`snapshotId\`. After the page changes, look again:
   old refs stop working (you get a 409 saying so).
5. **read** returns the page's text again; **screenshot** returns a PNG as base64 when the layout
   matters: \`curl -s "\${H[@]}" "$B/screenshot" | jq -r .base64 | base64 -d > /tmp/page.png\`, then view it.

## When you need a person

- **A login, captcha, 2FA prompt, or a step you do not know how to do:** call **ask-for-help** with
  a short reason. A person is notified (in the Mattermost thread you are in, if any) and takes over.
- **Then wait in the same run:** call **wait** in a loop until it answers \`"done": true\`. Each call
  waits up to 20 seconds. Do not end your turn and do not ask the person to tell you they are done:
  handing the computer back is how they say it. Then look again and carry on with the task.
  \`for i in $(seq 1 45); do r=$(curl -s "\${H[@]}" "$B/wait"); echo "$r" | jq -e .done >/dev/null && break; done; echo "$r"\`
- **A password or secret for a field:** look, then call **ask-for-password** with the field's
  \`ref\`, \`snapshotId\` and a \`label\` ("GoHighLevel password"), then **wait** the same way. A person
  types it straight into the field; you never see it. Never ask for passwords in chat, and never type
  passwords, card numbers or codes you were given in chat.

## Learning from people

Whenever a person uses your computer (because you asked, or because they stepped in), the next answer
you get has a \`personDid\` field with the steps they took: what they clicked and which fields they
typed into (never what they typed). When those steps do something you may need again:

- **Save them as a how-to** (POST /howtos): a short \`name\` for the task ("Export contacts from
  GoHighLevel"), the \`site\`, and \`steps\` rewritten as instructions you can follow, with the values
  the person typed turned into what you will need to fill in ("type the contact's email into Search").
- **When a person corrects you** (in chat, or by taking over and doing it differently), update the
  how-to: save it again under the same name.
- **When asked to teach another agent**, POST /howtos/teach with the how-to's \`name\` and the
  \`agent\` (its name). They get a copy of it.

## Shared computers

The board can set up shared computers, for example "GoHighLevel", logged in once for everyone.
GET /computers lists the ones you may use. Add \`"computer": "GoHighLevel"\` to any call (or
\`?computer=GoHighLevel\` on GET calls) to use it instead of your own. Only one agent uses a shared
computer at a time: if another agent has it you get a 409 saying who; try later. When you are done,
POST /release {"computer": "GoHighLevel"} so others can use it (it also frees itself 10 minutes after
your last call).

## Calls

GET  /status                     who has the computer (\`holder\`: bot or human), pending requests
GET  /wait                       returns when a person is done; call again until done is true
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
GET  /howtos                     what people have shown you
POST /howtos            {"name","site","steps","notes"}   save or update one
POST /howtos/forget     {"name"}
POST /howtos/teach      {"name","agent"}
GET  /computers                  your own and the shared computers you may use
POST /release           {"computer"}

A site outside the ones you are allowed fails to load; say so rather than looking for a way round.
`;

export const SKILL = `---
name: agent-computer
description: >
  Use when a task needs the web: open and read websites on your own computer, click and type, stay
  logged in between runs, hand the computer to a person for logins, captchas, 2FA, passwords or steps
  you do not know, learn how-tos from what people show you, and use shared computers.
---

${HELP}`;
