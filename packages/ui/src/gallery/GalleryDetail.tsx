import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { GalleryItem } from '@manga/shared';
import { api, imageUrl, seg } from '../api';
import { ConfirmIconButton } from '../ui/ConfirmIconButton';
import { IconButton } from '../ui/IconButton';
import { ExternalLink } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { errorText, pushToast } from '../ui/toasts';
import { editorPath, formatCreated, itemTitle, sizeLabel, sourceLabel } from './galleryModel';

/** The lightbox: the full image, how it was made, a link to where it lives and a delete. */
export function GalleryDetail({ item, onClose }: { item: GalleryItem | null; onClose(): void }): JSX.Element | null {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/images/${seg(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gallery'] });
      onClose();
    },
    onError: (err) => pushToast('error', errorText(err)),
  });
  if (item === null) return null;
  const { image } = item;
  const gen = image.gen;
  const path = editorPath(item);
  return (
    <Modal open onClose={onClose} title={itemTitle(item)} width={760}>
      <div className="gallery-detail">
        <img className="gallery-detail__img" src={imageUrl(image.id)} alt={itemTitle(item)} />
        <dl className="gallery-meta">
          <dt>Source</dt><dd>{sourceLabel(image.source)}{item.active ? ' · active' : ''}</dd>
          {gen && <><dt>Recipe</dt><dd>{gen.recipe}</dd><dt>Seed</dt><dd>{gen.seed}</dd></>}
          <dt>Size</dt><dd>{sizeLabel(image.width, image.height)}</dd>
          <dt>Created</dt><dd>{formatCreated(image.createdAt)}</dd>
        </dl>
        {gen && gen.prompt !== '' && (
          <details className="gallery-prompt">
            <summary>Prompt</summary>
            <p>{gen.prompt}</p>
          </details>
        )}
        <div className="gallery-detail__actions">
          {path !== null && <IconButton icon={ExternalLink} label="Open in editor" tipSide="top" onClick={() => { onClose(); void navigate(path); }} />}
          <ConfirmIconButton label="Delete image" confirmLabel="Click again to delete" onConfirm={() => remove.mutate(image.id)} />
        </div>
      </div>
    </Modal>
  );
}
