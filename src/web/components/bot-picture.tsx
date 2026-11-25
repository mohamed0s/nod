import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  agentColors,
  agentEmoji,
  agentPictureTypes,
  isAgentEmoji,
  type Agent,
  type AgentColor,
} from '../../shared/agents';
import type { Artifact } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { cn } from '../lib/utils';
import { FileImage, Pencil } from './icons';
import { Button, Input, Notice } from './ui';
import './bots.css';

export type BotLook = Pick<Agent, 'emoji' | 'color' | 'imageId'>;

const colorNames: Record<AgentColor, string> = {
  blush: 'Blush',
  rose: 'Rose',
  pink: 'Pink',
  berry: 'Berry',
  mist: 'Mist',
  stone: 'Stone',
  slate: 'Slate',
  ink: 'Ink',
};

const sourceBytes = 20 * 1024 * 1024;

export function BotPicture({
  bot,
  size = 'sm',
  className,
}: {
  bot: BotLook;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'hero';
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const image = bot.imageId && bot.imageId !== broken ? bot.imageId : null;
  return (
    <span
      className={cn('bot-picture', className)}
      data-size={size}
      data-color={bot.color}
      aria-hidden="true"
    >
      {image ? (
        <img
          src={`/api/artifacts/${image}`}
          alt=""
          draggable={false}
          onError={() => setBroken(image)}
        />
      ) : (
        bot.emoji
      )}
    </span>
  );
}

const Pictures = createContext<Agent[]>([]);

export function BotPictures({ agents, children }: { agents: Agent[]; children: ReactNode }) {
  return <Pictures.Provider value={agents}>{children}</Pictures.Provider>;
}

export function BotName({ name }: { name: string }) {
  const key = name.toLocaleLowerCase();
  const bot = useContext(Pictures).find((agent) => agent.name.toLocaleLowerCase() === key);
  return (
    <span className="message-agent">
      {bot && <BotPicture bot={bot} size="xs" />}
      {name}
    </span>
  );
}

async function squared(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be read. Choose another PNG, JPEG, WebP or GIF.');
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(256, side);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas
    .getContext('2d')
    ?.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This image could not be resized. Choose another one.');
  return new File([blob], 'bot-picture.png', { type: 'image/png' });
}

async function uploadPicture(file: File) {
  if (!agentPictureTypes.includes(file.type))
    throw new Error(`Choose a PNG, JPEG, WebP or GIF image, not ${file.type || 'this file'}.`);
  if (file.size > sourceBytes)
    throw new Error(`Choose an image under ${sourceBytes / 1024 / 1024} MB.`);
  const body = new FormData();
  body.append('file', await squared(file));
  return (await api<Artifact>('/api/uploads', { method: 'POST', body })).id;
}

export function PictureEditor({
  value,
  onChange,
}: {
  value: BotLook;
  onChange(value: BotLook): void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  async function upload(chosen: File) {
    setBusy(true);
    setError('');
    try {
      onChange({ ...value, imageId: await uploadPicture(chosen) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="bot-picture-button" aria-label="Change picture">
          <BotPicture bot={value} size="xl" />
          <span className="bot-picture-badge" aria-hidden="true">
            <Pencil size={12} />
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="menu bot-picture-editor"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <div className="bot-emoji-grid" role="group" aria-label="Emoji">
            {agentEmoji.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="bot-emoji"
                aria-pressed={!value.imageId && value.emoji === emoji}
                onClick={() => onChange({ ...value, emoji, imageId: null })}
              >
                {emoji}
              </button>
            ))}
          </div>
          <Input
            aria-label="Any emoji"
            placeholder="Or type any emoji"
            value={typed}
            maxLength={16}
            onChange={(event) => {
              setTyped(event.target.value);
              const emoji = event.target.value.trim();
              if (isAgentEmoji(emoji)) onChange({ ...value, emoji, imageId: null });
            }}
          />
          <div className="bot-color-row" role="radiogroup" aria-label="Background">
            {agentColors.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                className="bot-color"
                data-color={color}
                aria-checked={value.color === color}
                aria-label={colorNames[color]}
                title={colorNames[color]}
                onClick={() => onChange({ ...value, color })}
              />
            ))}
          </div>
          <div className="bot-picture-upload">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              <FileImage size={16} aria-hidden="true" />
              {busy ? 'Uploading…' : value.imageId ? 'Replace image' : 'Upload image'}
            </Button>
            {value.imageId && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onChange({ ...value, imageId: null })}
              >
                Use the emoji
              </Button>
            )}
            <input
              ref={file}
              type="file"
              hidden
              accept={agentPictureTypes.join(',')}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                if (chosen) void upload(chosen);
              }}
            />
          </div>
          <p className="field-hint">PNG, JPEG, WebP or GIF. Nod crops it to a square.</p>
          {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
