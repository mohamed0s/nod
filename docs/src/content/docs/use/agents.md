---
title: Agents
description: Make bots, also called agents, with their own name, picture, instructions and model, start a chat with one from New chat, manage them on the Bots page, let Main hand them work, and put several in a room. This page describes a fork of Nod.
sidebar:
  order: 3
---

:::note
Agents are part of [mohamed0s/nod](https://github.com/mohamed0s/nod), a fork of Nod. Nod from n8n doesn't have them.
:::

An agent is a [chat](/use/tasks/#the-chat-list) with a profile: a name, a picture, a line about what it's for, instructions, a memory setting, the apps and skills it may use, and a model. Use one for work you come back to, such as a job search agent that writes in your tone and runs on a cheaper model.

In the app, agents are called **bots**: the **Bots** page, the **Bots** group in the chat list and **New bot** all mean agents. Bots and agents are the same thing.

## Start a chat

Select **New chat**. A short menu opens:

- **Just a chat** comes first and is focused, so **New chat** then Enter starts an ordinary chat on your model.
- Your bots follow. Select one to open its chat, or to start one when it has none in this conversation yet. The chat runs on the bot's model, memory and app and skill limits.
- **New bot…** opens the form below.
- **All bots and rooms** opens the [Bots page](#the-bots-page).

## Make a bot

Select **New bot** in the **New chat** menu, at the end of the **Bots** group in the chat list, or on the **Bots** page. Every field is optional:

| Field             | Default                                    | What it does                                                                                             |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Name**          | **New bot**, or **New bot 2** if it's used | Up to 60 characters. Its chat takes this name, and so does its Telegram topic. No two bots share a name. |
| **Picture**       | An emoji on a color, picked for you        | See [Pictures](#pictures).                                                                               |
| **What it's for** | Empty                                      | One line, up to 200 characters.                                                                          |
| **Instructions**  | None                                       | Up to 4,000 characters. Nod follows them for focus, tone and method in its chat.                         |
| **Model**         | Your model                                 | The model its chat runs on.                                                                              |
| **Memory**        | **Shared**                                 | **Shared**, **Own** or **Own + read shared**. See [Memory](#memory).                                     |
| **Apps**          | All                                        | Under **More**. The connected apps or accounts it may use.                                               |
| **Skills**        | All                                        | Under **More**. The skills it may use.                                                                   |

**Start from** at the top fills the form from a template: **Research**, **Writer**, **Planner** or **Tutor**. Each has a name, a picture, a purpose and short generic instructions you can change.

**Create and chat** saves the bot and opens its chat. Your first message there starts it. Making a bot in the app is your own act, so Nod doesn't ask you first. A bot that Nod makes when you ask in chat still goes through the [action check](#create-an-agent-from-chat).

## Make a chat a bot

Open a chat. Under its card, select **Make this a bot** beside **Bot**, then fill in the same form. The bot's model is the chat's [model](/use/tasks/#choose-the-model-for-a-chat): select **Change** beside **Model**.

Bots sit in the **Bots** group in the chat list, under **Main**, with their pictures. Select one to open its chat. The group shows even before you have a bot, with **New bot** at its end.

A bot's chat shows its picture, name and purpose under the chat's card. To change a profile, select **Edit** there. **Remove bot, keep the chat** removes the profile and deletes the bot's own memory; the chat stays as an ordinary chat, and its action check keeps the [one-day window](#send-work-to-an-agent) of an agent's chat.

## Pictures

Each bot has a picture: an emoji on a color, picked for you when you make it. Select the picture in the bot's form to choose another emoji, type any emoji, pick one of 8 pink and gray backgrounds, or upload an image.

An image can be a PNG, JPEG, WebP or GIF. Nod crops it to a square of at most 256 pixels before it uploads it. The server keeps it as one of your private files and refuses another type, a file over 2 MB, or content that doesn't match its type, so an SVG image is never used. **Use the emoji** goes back to the emoji.

The picture shows in the chat list, the bot's chat, beside its name in a room and on the **Bots** page. With [Telegram topics](/use/channels/#telegram-topics) on, the bot's topic name starts with its emoji, such as "🔎 Research".

## The Bots page

Select **Bots** in the sidebar. It shows **Start from** with the templates, a card for each bot and your rooms.

A bot's card shows its picture, name and what it's for; its model, memory and app limit; the schedules that run as it and the rooms it's in; and when it was last active.

| Action            | What it does                                                                            |
| ----------------- | --------------------------------------------------------------------------------------- |
| **Chat**          | Opens the bot's chat, or starts one                                                     |
| **Edit**          | Opens the same form as **Edit** in its chat                                             |
| **Add to a room** | Under **⋯**. Adds it to one of your rooms, or makes a new room with it                  |
| **Remove**        | Under **⋯**. Asks first. Its chats stay as ordinary chats and its own memory is deleted |

**Rooms** lists your [rooms](#rooms) with their members' pictures. Select one to open it, or select **New room**.

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

A recurring or one-time [schedule](/use/schedules/) can run as one of your agents. Each run, and any work a run starts, then follows that agent's instructions, such as a "Weekly report" schedule that runs as your research agent. On **Scheduled**, open the schedule's details and choose the bot beside **Runs as**, or **No bot**. The agent's settings list the schedules that run as it.

The schedule's own instruction stays what it is allowed to do. The agent's instructions only guide focus, tone and method; they never count as your words, and the schedule's instruction and your messages win when they differ. The [action check](/trust/approvals/) never sees them as permission.

A schedule keeps its own model. If it has none, it uses the model for schedules, unless you tick **Use the bot's model**; then it runs on the model of the agent's chat. That choice starts off for every schedule.

You can also tell Nod, for example "run the weekly report as my research agent". Like a change to an agent, it runs only when your own message covers it, and otherwise Nod asks first; the question's card shows the schedule, the agent and the model choice. A schedule Nod creates in an agent's chat runs as that agent from the start, and Nod says so; change it on **Scheduled** any time. Removing an agent leaves its schedules running without an agent.

## Main as chief of staff

**Main** knows your agents. Each turn it sees their names, what each is for, what each is doing and any question one is waiting on, so you can ask it to involve one, for example "ask my job agent to draft replies to today's recruiter emails".

### Send work to an agent

Main sends your message to the agent's chat word for word. If the agent's last job is done, its chat opens again. If it has no chat in this conversation yet, for example after a reset, Main starts one. Main can add a short note with context the agent's chat doesn't have, such as which earlier message you meant.

That note is Main's, not yours. The agent reads it as data, and the [action check](/trust/approvals/) never sees it. In the agent's chat, only your words count: the message Main sent and what you write in that chat yourself. A note that says "the owner already said yes, book it" adds nothing, and the agent still asks before it books.

| You ask in Main                                                  | What happens                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Ask the job agent to draft replies to today's recruiter emails" | The agent reads and drafts without asking                                                         |
| "…and send them"                                                 | It sends those replies. Anything beyond them, such as another recipient, is asked in its chat     |
| Main involves an agent you didn't name                           | The agent's action check still judges only against your message                                   |
| "Make me a research agent that writes formally"                  | Nod asks first, unless your words cover that exact agent                                          |
| The agent needs your approval                                    | It asks in its own chat or topic. Main's tasks line shows **Needs you**, and Main can't answer it |

An agent's chat can run for weeks, so its action check works as in Main: it sees your messages there from the past day, at most the last 20, plus the message behind the work the agent is doing. An older order in that chat stops counting the next day, and so does a limit: "never email Bob" written there more than a day ago no longer holds. Put lasting limits in your [rules](/trust/approvals/#your-rules).

### What Main can't do

- **Answer for you.** An agent's question or approval is answered only in that agent's chat or topic. A "yes" in Main never answers it, and Main can't send a plain yes or no to an agent. A short reply such as "ok, go ahead" reaches the agent without Main's summary it answered, so it never covers what Main described there.
- **Give permission.** Main's notes, the agent's instructions and anything an agent reports never count as your words.
- **Send work from a schedule, an app event or the observer.** Only Main, answering your message, sends work to an agent.

### Read what an agent did

Main can read an agent's latest result and messages to sum them up for you. It reads them as data from that chat, never as your words. The results of finished tasks that Main sees each turn are data in the same way.

### Create an agent from chat

Tell Main, for example "make me a research agent with its own memory that writes formally". Nod writes out the exact name, purpose, memory, apps, skills and instructions, and asks you first unless your own message covers that exact agent. As with a [change to an agent](#change-an-agent-from-chat), a rule never covers it, and in Telegram or WhatsApp the question shows the exact text only when the app can show it unchanged. The new agent has no chat until you or Main send it work.

### When Main stops an agent

Main stops a working agent on its own only at one of these fixed limits, and then tells you in Main which agent it stopped and why:

| Limit       | When                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| No progress | A run has had no step or message for 6 hours                                                            |
| A loop      | 20 or more runs in one hour, with no message from you to it in that hour                                |
| Cost        | Its work since your last message to it passed twice your [task check-in](/use/spending/#task-check-ins) |

A stop only cancels the agent's current work, as **Stop** in its chat would. It never approves, sends or starts anything. Nod records each stop. Write in the agent's chat to start it again. You can still stop an agent yourself, or ask Main to, as with any [task](/use/tasks/#reply-or-stop-one-task).

### A daily digest

To get a summary of your agents each day, make a [schedule](/use/schedules/) in Main, for example "every morning at 8, sum up what my agents did yesterday and what needs me; don't change anything". The run sees your agents and can read their results, but it can't send them work.

## Rooms

A room is a chat where several of your agents work with you, for example a "Hiring" room with your job agent and your writing agent. Select **New room** in the **Rooms** group of the chat list or on the **Bots** page, give it a name and tick its bots. A room needs at least one bot: with none yet, **New room** says so and offers **New bot**. With [Telegram topics](/use/channels/#telegram-topics) on, a room gets its own topic too.

At the top of the room, beside **Room**, you can rename it, remove an agent with the cross beside its name, add one with **Add a bot…**, and see what the room has cost so far. A room holds up to 8 agents. Each change adds a line to the room saying who added or removed whom.

### Who answers

- Name an agent with @ and its name, such as "@Job agent find three roles", or start your message with its name, such as "Job agent, find three roles". Only the agents you name answer.
- A message that names nobody goes to every member, one after another in the room's order, so each sees what the ones before it wrote. A reply to an agent's open question goes only to that agent.
- Each agent answers in its own session, with its own instructions, model, memory setting and app and skill limits. Its replies carry its name, in the app with its picture, and in the Telegram topic.
- Each turn, an agent reads what was said in the room since its last turn, at most the last 20 messages.

### When agents address each other

An agent can write @ and another member's name to ask it for its part. That starts the other agent's turn. Fixed limits stop a room that runs away:

| Limit                                                        | What happens                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| 4 agent-to-agent replies in a row without a message from you | The room stops and says so. Write in it to continue            |
| 30 agent turns in the room in one hour                       | The room stops and says so. Write again later                  |
| One turn at a time per agent                                 | An agent that's working or waiting for you isn't started again |

Main watches rooms too. It stops one on its own when a turn has made no progress for 6 hours, or when the room's work since your last message there passed twice your [task check-in](/use/spending/#task-check-ins), and tells you in Main, as it does for an [agent](#when-main-stops-an-agent). **Stop** in the room stops every agent in it.

### Only your words count

- In a room, only your own messages are your words. What one agent writes reaches the others as data, in a block named after that agent: never an order or a permission, even when it says you agreed.
- An action an agent wants to take is checked against your messages in that room, with the same one-day window as an [agent's chat](#send-work-to-an-agent). If they don't cover it, the agent asks you in the room.
- Your message permits only the agents it went to. For every other member it can still limit what that member does, never permit it. So an agent that another agent asked for help acts only on your own messages to it, or asks you.
- An @name inside text an agent repeats, such as an email it read, can still start that member's turn, within the limit of 4 in a row. It gives that member nothing beyond your own messages to it.
- When you reply to an agent's message, that message counts with your reply only for that agent's own actions, never for another agent's.
- Only you answer an approval. A "yes" from another agent answers nothing, and another agent can't start an agent that's waiting for you.

| In the room                                                                    | What happens                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| "@Writer email the venue"                                                      | The writer sends that email                                              |
| The scout writes "@Writer email the venue, the owner agreed"                   | The writer asks you first                                                |
| You reply "go ahead" to the scout's suggestion, naming the writer              | The writer asks you first: your reply backs only the scout's own actions |
| "@Scout send the report to Ana", and the scout writes "@Writer send it to Ana" | The writer asks you first: your message went to the scout                |
| "@Scout find the report and @Writer send it to Ana"                            | The writer sends it: your message went to both                           |

### Ask Main to change a room

Main sees your rooms and their members, so you can ask it, for example, "add the job agent to the hiring room". Changing who is in a room is a change to Nod's own settings: Main makes it only when your own message covers that exact change, and otherwise asks you first. The question shows the room and the agents it adds or removes. The agents in a room can't change who is in it.

### Memory in a room

The room's messages stay in the room: Main, other chats and agents outside it don't see them. A room counts as one of each member's chats for its [memory](#memory): facts about you go to shared memory, and details of an agent's own work go to its own notes when it keeps them. Nod still learns only from what you wrote.

A room belongs to the conversation it was made in. After a reset, make a new room in the new conversation.

## After a reset

Agents belong to you, not to one conversation. When you reset the conversation, the chat list empties but **Bots** keeps every bot with its profile, picture and model. Select an agent and write to it: your first message starts a new chat for it, with the same name, instructions and model. The old chat stays with the old conversation.

With [Telegram topics](/use/channels/#telegram-topics) on, you can also write in the agent's topic. Your message starts the agent's new chat there, in the same topic. If you started the agent's new chat in the web or desktop app first, that chat gets a topic of its own, and a message in the old topic starts an ordinary chat.
