---
title: Turn traces
description: See every model call a turn makes while you develop Nod, with the exact system prompt, tools, messages, response, tokens and cost.
sidebar:
  order: 10
---

When you change a prompt, a tool or how a turn runs, you need to see what the model actually received. Turn traces show it beside the chat, one model call at a time, without leaving the app.

The short version: in a source install, select **Show trace** in the chat toolbar. The **Trace** panel opens beside the chat and follows the latest turn as it runs.

## When traces are on

Traces exist only in dev mode: a source install started with `pnpm dev`, which sets `NODE_ENV=development`. `pnpm dev:server` records them only when you set `NODE_ENV=development` yourself. `pnpm start`, the self-host image, a server with `NOD_ENVIRONMENT` set to anything other than `development`, and the desktop app never record them, and the panel and its routes aren't there.

There is no extra switch. In dev mode Nod stores every model call made inside a turn, whether or not the panel is open, including the memory curator's calls that conversation traces leave out. Work that starts after a turn ends, such as proactive checks, isn't part of it. If the database falls behind, Nod drops new traces rather than holding them in memory.

## What the panel shows

The header shows the turn's duration, model calls, tool calls, input tokens (with how many the provider served from its cache), output tokens and cost. Pick an earlier turn from the list under the title, or keep **Latest turn** to follow new work. The list holds turns that started; a message you sent while Nod was working joins the running turn, so its trace is there.

`GET /api/traces` lists the same turns. **Full screen** in the panel header fills the window with the trace; **Exit full screen** or Escape puts it back beside the chat.

| Tab           | What it shows                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline      | Each model call on a shared time scale: agent, subagent or memory curator, the model, duration, tokens and cost, and the tool calls it asked for. Below it, the turn's recorded events.  |
| System prompt | The full system prompt the selected call sent, including the tool guidelines Pi adds.                                                                                                    |
| Tools         | Every tool the call offered, with its description and full input schema, and roughly how many tokens each costs.                                                                         |
| Messages      | Every message in the request, in order, including the owner context, tool results and thinking, then the model's response and stop reason. JSON inside a message shows as nested fields. |
| Raw           | The whole stored trace for the turn as JSON, with a copy button.                                                                                                                         |

Select a call on the timeline to open its messages. The other tabs follow the selected call, or the main agent's first call when none is selected.

## Start over

**Reset chat** in the chat toolbar, also dev mode only, forgets every memory note and learned skill, stops running work and starts an empty chat. Past tasks, files, connected accounts, schedules and settings stay.

## Where traces are stored

Each model call is one row in the `model_call_traces` table, keyed to its turn. They survive restarts, and rows older than 14 days are deleted.

Before a call is stored, Nod removes the secret values it knows, values under secret field names (also inside JSON text) and image data, and shortens home folder paths to `~`. Everything else stays, including private messages, because that is what you are debugging. This scrubbing is best effort: it can miss a secret or a personal detail, and it doesn't make a trace anonymous, so read a trace before you share it.

The rows never leave your computer. If you also turn on [conversation traces](/trust/conversation-traces/), the same model calls are sent, separately redacted, to n8n while that switch is on, as in any other install.

`GET /api/turns/:id/trace` returns the same data as the panel, for your own scripts. It needs the owner key like every other route, answers only for your own turns, and exists only in dev mode.
