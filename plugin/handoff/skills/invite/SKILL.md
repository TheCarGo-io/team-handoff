---
description: Invite someone to the handoff board (admins only)
argument-hint: [team] [admin]
allowed-tools: mcp__plugin_handoff_handoff__invite, mcp__plugin_handoff_handoff__members
---

Create an invite link with the handoff `invite` tool. Request: $ARGUMENTS

The first word is the team the newcomer joins; a team that does not exist yet is created. With no team the newcomer chooses one of the existing teams on the join page. The word `admin` makes them an admin, who can invite and remove people. If the request names a team you are not sure exists, call `members` first and say that the invite will create it.

Show the user the link exactly as returned, on its own line, with who it is for and when it expires. Say that it works once: the newcomer opens it in a browser, picks a name and gets their own token together with the install commands. Do not open the link yourself and do not create more than one invite per person asked for.

If the tool answers that only an admin can invite, say so and stop.
