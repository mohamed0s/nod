import type { Agent } from '../../shared/agents';
import { navigate } from '../lib/navigation';
import { ActionMenu, ActionMenuItem } from './action-menu';
import { BotPicture } from './bot-picture';
import { LayoutGrid, MessageCircle, Plus } from './icons';
import { Button } from './ui';

export function NewChatMenu({
  agents,
  fresh,
  onChat,
  onNewChat,
  onNewBot,
}: {
  agents: Agent[];
  fresh: boolean;
  onChat(id: string): void;
  onNewChat(agent?: string): void;
  onNewBot(): void;
}) {
  return (
    <ActionMenu
      label="New chat"
      align="start"
      className="chat-list-new-menu"
      contentClassName="new-chat-menu"
      trigger={
        <Button
          variant="outline"
          size="sm"
          className="chat-list-new"
          aria-current={fresh ? 'page' : undefined}
        >
          <Plus size={16} aria-hidden="true" />
          New chat
        </Button>
      }
    >
      {(close) => (
        <>
          <ActionMenuItem
            textValue="Just a chat"
            onClick={() => {
              close();
              onNewChat();
            }}
          >
            <MessageCircle size={16} aria-hidden="true" />
            <span>
              Just a chat
              <small>Your default model and memory</small>
            </span>
          </ActionMenuItem>
          {agents.length > 0 && (
            <>
              <div className="new-chat-menu-separator" role="separator" />
              <div className="new-chat-menu-heading" aria-hidden="true">
                Your bots
              </div>
            </>
          )}
          {agents.map((agent) => (
            <ActionMenuItem
              key={agent.id}
              textValue={agent.name}
              onClick={() => {
                close();
                if (agent.chatId) onChat(agent.chatId);
                else onNewChat(agent.id);
              }}
            >
              <BotPicture bot={agent} size="md" />
              <span>
                {agent.name}
                {agent.description && <small>{agent.description}</small>}
              </span>
            </ActionMenuItem>
          ))}
          <div className="new-chat-menu-separator" role="separator" />
          <ActionMenuItem
            textValue="New bot"
            onClick={() => {
              close();
              onNewBot();
            }}
          >
            <Plus size={16} aria-hidden="true" />
            <span>
              New bot…
              <small>Name, picture, instructions, memory</small>
            </span>
          </ActionMenuItem>
          <ActionMenuItem
            textValue="All bots"
            onClick={() => {
              close();
              navigate('/bots');
            }}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            <span>All bots and rooms</span>
          </ActionMenuItem>
        </>
      )}
    </ActionMenu>
  );
}
