import { useState } from 'react';
import type { PageView } from '../../shared/pages';
import { errorMessage, post } from '../lib/api';
import { ownedArtifactUrl } from '../lib/attachment-url';
import { navigate } from '../lib/navigation';
import type { ImagePreview } from './attachment-images';
import { artifactFromPreview } from './file-actions';
import { LayoutDashboard } from './icons';
import { Button } from './ui';

export function KeepInPages({ item }: { item: ImagePreview }) {
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<PageView | null>(null);
  const artifact = artifactFromPreview(item);
  if (!ownedArtifactUrl(artifact.url)) return null;
  if (page)
    return (
      <Button variant="ghost" size="sm" onClick={() => navigate(`/pages?page=${page.id}`)}>
        Open in Pages
      </Button>
    );
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={busy}
      aria-label={`Keep ${item.name} in Pages`}
      title="Keep in Pages"
      onClick={async () => {
        setBusy(true);
        try {
          setPage(await post<PageView>('/api/pages', { artifactId: artifact.id }));
        } catch (cause) {
          window.dispatchEvent(
            new CustomEvent('nod:file-notice', {
              detail: `Nod couldn't keep ${item.name} in Pages: ${errorMessage(cause)}`,
            }),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <LayoutDashboard size={16} />
    </Button>
  );
}
