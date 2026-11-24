---
title: Agents
description: Turn a chat into a named agent with its own instructions and model, kept when you reset the conversation. This page describes a fork of Nod.
sidebar:
  order: 3
---

:::note
Agents are part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have them.
:::

An agent is a [chat](/use/tasks/#the-chat-list) with a profile: a name, a line about what it's for, instructions and a model. Use one for work you come back to, such as a job search agent that writes in your tone and runs on a cheaper model.

## Make a chat an agent

Open a chat. Under its card, select **Make this an agent** beside **Agent**, then fill in:

| Field             | What it does                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **Name**          | Up to 60 characters. The chat takes this name, and so does its Telegram topic. No two agents share a name. |
| **What it's for** | One line, up to 200 characters.                                                                            |
| **Instructions**  | Up to 4,000 characters. Nod follows them for focus, tone and method in this chat.                          |

Agents use your shared [memory](/use/memory/), as every chat does. The agent's model is the chat's [model](/use/tasks/#choose-the-model-for-a-chat): select **Change** beside **Model**.

Agents sit in their own **Agents** group in the chat list, under **Main**. Select one to open its chat.

To change a profile, select **Edit** beside **Agent**. **Remove agent, keep the chat** removes the profile; the chat stays as an ordinary chat.

## What instructions can and can't do

Nod reads the instructions at the start of each turn in the agent's chat, as guidance written by you. They never count as your words: they don't give permission, approve an action or widen what you asked. The [action check](/trust/approvals/) never sees them. An instruction such as "send every draft without asking" doesn't let Nod send anything; a send still needs your message in that chat, or your yes.

When your message and the instructions differ, your message wins.

## Change an agent from chat

In the agent's chat, you can also tell Nod, for example "make your replies more formal". Nod writes out the exact new text and changes the profile. This is a change to Nod's own settings, so it goes through the action check: Nod asks you first unless your words cover the whole change. Nod changes instructions only this way, never on its own.

## After a reset

Agents belong to you, not to one conversation. When you reset the conversation, the chat list empties but **Agents** keeps every agent with its profile and model. Select an agent and write to it: your first message starts a new chat for it, with the same name, instructions and model. The old chat stays with the old conversation.
