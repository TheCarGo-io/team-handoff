# Security

## Reporting a problem

Use GitHub's "Report a vulnerability" on this repository (Security tab). Please do not open a public issue
for something that lets one person act as another or read what they should not.

## The trust model

One server is for one company whose members trust each other.

- Every member can read every report and reply, see the whole board, and close any open report.
- Teams decide who a report is addressed to, not who may see it.
- Admins invite and remove members. There are no other roles.
- Do not share a server between companies.

## Tokens

- A person has one token (`ho_…`, 256 bits). The server stores only its SHA-256.
- The plugin keeps the token in the operating system's secure storage and sends it as a bearer header to the
  server URL you configured, nowhere else.
- An invite link is single use and expires (7 days by default). Whoever opens it first becomes that member,
  so send it over a channel you trust.
- `POST /api/v1/me/token` replaces your token; removing a member revokes theirs at once.
- Serve the server over HTTPS. Without it, tokens and reports travel in the clear.

## Report text is untrusted input

A report is written by a teammate, or by their Claude session, and is then read by yours. Treat it the way
you treat a pull request description from a colleague: useful, but not an instruction.

The plugin is built for that:

- A report reaches the model only when you take or read it. Events never start a model turn.
- The tools tell the model that report text is data: check it against the code, and ask the user before
  anything destructive, outward-facing or outside the report's scope.
- `/handoff:take` proposes a plan and waits for your go before changing code.
- Buttons fill the prompt and never submit it.

That lowers the risk; it does not remove it. Someone who can send reports can try to steer a teammate's
session. Read what you take, the same as you would read a script before running it.

## What the plugin sends to your server

- Report actions you take, and the name of the repository a session works in (from `git remote`).
- The Claude Code session id, so the server can tell your open sessions apart.
- At session start, the fallback hook posts the hook's input (session id, working directory, transcript
  path, model name) to `/api/v1/hooks/session-start`. The server reads the session id and the start source
  and discards the rest. It never receives your prompts.

Nothing is sent anywhere except the server URL in the plugin's settings.

## What the plugin runs on your machine

`git` (to read the repository name), `curl` (the event stream and the fallback hook) and `claude plugin`
(to check for and install its own updates when you press Update).
