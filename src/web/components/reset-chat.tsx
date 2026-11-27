import { useState } from 'react';
import { RotateCcw } from './icons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Notice,
} from './ui';
import { Tooltip } from './tooltip';
import { errorMessage } from '../lib/api';

export function ResetChat({ onReset }: { onReset(): Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reset() {
    setBusy(true);
    setError('');
    try {
      await onReset();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && setOpen(value)}>
      <Tooltip content="Reset chat">
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Reset chat" onClick={() => setError('')}>
            <RotateCcw size={16} />
          </Button>
        </DialogTrigger>
      </Tooltip>
      <DialogContent className="delete-plan-dialog">
        <DialogTitle>Reset chat?</DialogTitle>
        <DialogDescription>
          Starts an empty chat and forgets every memory note and learned skill.
          <span>
            Running work stops. Past tasks, files, connected accounts, schedules and settings stay.
            Dev mode only.
          </span>
        </DialogDescription>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="delete-plan-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void reset()}>
            {busy ? 'Resetting…' : 'Reset chat'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
