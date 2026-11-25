---
title: Agents
description: Turn a chat into a named agent with its own instructions and model, kept when you reset the conversation. This page describes a fork of Nod.
sidebar:
  order: 3
---

:::note
Agents are part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have them.
:::

An agent is a [chat](/use/tasks/#the-chat-list) with a profile: a name, a line about what it's for, instructions, a memory setting, the apps and skills it may use, and a model. Use one for work you come back to, such as a job search agent that writes in your tone and runs on a cheaper model.

## Make a chat an agent

Open a chat. Under its card, select **Make this an agent** beside **Agent**, then fill in:

| Field             | What it does                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **Name**          | Up to 60 characters. The chat takes this name, and so does its Telegram topic. No two agents share a name. |
| **What it's for** | One line, up to 200 characters.                                                                            |
| **Instructions**  | Up to 4,000 characters. Nod follows them for focus, tone and method in this chat.                          |
| **Memory**        | **Shared**, **Own** or **Own + read shared**. See [Memory](#memory).                                       |
| **Apps**          | The connected apps or accounts it may use. None chosen means all.                                          |
| **Skills**        | The skills it may use. None chosen means all.                                                              |

The agent's model is the chat's [model](/use/tasks/#choose-the-model-for-a-chat): select **Change** beside **Model**.

Agents sit in their own **Agents** group in the chat list, under **Main**. Select one to open its chat.

To change a profile, select **Edit** beside **Agent**. **Remove agent, keep the chat** removes the profile and deletes the agent's own memory; the chat stays as an ordinary chat.

## Memory

| Setting               | What the agent reads                 | Where its notes go                                    |
| --------------------- | ------------------------------------ | ----------------------------------------------------- |
| **Shared**            | Your shared [memory](/use/memory/)   | Shared memory, as in Main                             |
| **Own**               | Only its own notes                   | Facts about you to shared memory, its work to its own |
| **Own + read shared** | Its own notes and your shared memory | Facts about you to shared memory, its work to its own |

**Shared** is the default. A new agent with its own memory starts empty, and switching an agent never moves notes.

A fact about you, such as where you live or what you prefer, always goes to shared memory, even when you tell it to an agent with its own memory. A detail of the agent's work, such as a lead it follows or when a report is due, goes to the agent's own notes. The memory model labels each note; when it isn't sure, the note goes to shared memory. Nod still saves only what you wrote yourself, as in any chat.

In an agent's chat, asking Nod to forget a note, turn memory off or clear it acts on the agent's own memory, and the question says which memory it changes. An agent that reads shared memory can also forget a shared note. A schedule that runs as the agent reads memory the same way as its chat.

With **Own**, the agent's context stays its own too: searching earlier messages across chats finds only its own chats, never Main's or another agent's. **Own + read shared** searches every chat, as Main does. **Include sensitive details** is one setting for shared and agent memory; change it in shared memory. See and edit each agent's notes in **Settings → Memory**.

## Apps and skills

Choose the connected apps, or single accounts of an app, and the [skills](/how-it-works/skills/) an agent may use. The lists only narrow what it can use: they never give it an app you haven't connected, and every action still goes through the [action check](/trust/approvals/). With none chosen, it can use them all.

In the agent's chat and in runs of schedules that run as it, the limit covers:

- connected apps and MCP servers: calls from a tool or from code Nod runs, app search and the list of connected apps;
- [job mail](/use/job-search/#job-mail) reads from the Gmail account linked to your job search;
- skills: the list of guides and learned skills, and reading, saving or fixing another one.

Nod refuses anything else with the reason, before it sends anything. An app action that was waiting for your yes when you narrowed the list doesn't run either. The limit doesn't cover Nod's own browser and the sign-ins you saved for it, [computer use](/connect/computer-use/) or [local files](/connect/local-files/): they aren't connected apps, so they keep their own approvals and settings.

## What instructions can and can't do

Nod reads the instructions at the start of each turn in the agent's chat, as guidance written by you. They never count as your words: they don't give permission, approve an action or widen what you asked. The [action check](/trust/approvals/) never sees them as permission when it checks an action. An instruction such as "send every draft without asking" doesn't let Nod send anything; a send still needs your message in that chat, or your yes.

When your message and the instructions differ, your message wins.

## Change an agent from chat

In the agent's chat, you can also tell Nod, for example "make your replies more formal". Nod writes out the exact new text and changes the profile. This is a change to Nod's own settings, so it goes through the action check: Nod asks you first unless your own message in that chat covers the whole change. A rule or anything else never covers a change to an agent. This works for its apps and skills too, such as "only use Gmail and the research skill". In the Nod app, the question's card shows the exact new name, purpose, apps, skills and instructions. In Telegram or WhatsApp, the question ends with the exact new text only when the app can show it unchanged; otherwise it says to open the chat in the Nod app and read it there first. Such a question can only be answered in the app: its Telegram buttons are left off, and a yes or no typed in the chat app gets a reply to answer in the app instead. The question stays open until you answer it there. Nod changes instructions only this way, never on its own.

## Schedules that run as an agent

A recurring or one-time [schedule](/use/schedules/) can run as one of your agents. Each run, and any work a run starts, then follows that agent's instructions, such as a "Weekly report" schedule that runs as your research agent. On **Scheduled**, open the schedule's details and choose the agent beside **Runs as**, or **No agent**. The agent's settings list the schedules that run as it.

The schedule's own instruction stays what it is allowed to do. The agent's instructions only guide focus, tone and method; they never count as your words, and the schedule's instruction and your messages win when they differ. The [action check](/trust/approvals/) never sees them as permission.

A schedule keeps its own model. If it has none, it uses the model for schedules, unless you tick **Use the agent's model**; then it runs on the model of the agent's chat. That choice starts off for every schedule.

You can also tell Nod, for example "run the weekly report as my research agent". Like a change to an agent, it runs only when your own message covers it, and otherwise Nod asks first; the question's card shows the schedule, the agent and the model choice. A schedule Nod creates in an agent's chat runs as that agent from the start, and Nod says so; change it on **Scheduled** any time. Removing an agent leaves its schedules running without an agent.

## After a reset

Agents belong to you, not to one conversation. When you reset the conversation, the chat list empties but **Agents** keeps every agent with its profile and model. Select an agent and write to it: your first message starts a new chat for it, with the same name, instructions and model. The old chat stays with the old conversation.

With [Telegram topics](/use/channels/#telegram-topics) on, you can also write in the agent's topic. Your message starts the agent's new chat there, in the same topic. If you started the agent's new chat in the web or desktop app first, that chat gets a topic of its own, and a message in the old topic starts an ordinary chat.
