import { useRef, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Character, Image, RefSlot as Slot } from '@manga/shared';
import { api, imageUrl } from '../api';
import { cx } from '../lib/cx';
import { qk } from '../queryKeys';
import { IconButton } from '../ui/IconButton';
import { ChevronDown, Upload, UserRound } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { slotLabel } from './characterModel';

export function RefSlot({ character, slot, images }: { character: Character; slot: Slot; images: Image[] }): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const current = character.refs[slot];
  const name = slotLabel(slot);
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: qk.character(character.id) });
    void qc.invalidateQueries({ queryKey: qk.characterImages(character.id) });
    void qc.invalidateQueries({ queryKey: qk.characters(character.mangaId) });
  };
  const upload = useMutation({
    mutationFn: (file: File) => api.upload<Image>(`/api/characters/${character.id}/upload?slot=${slot}`, file, file.name),
    onSuccess: refresh,
  });
  const pick = useMutation({
    mutationFn: (imageId: string) => api.post<Character>(`/api/characters/${character.id}/refs/${slot}`, { imageId }),
    onSuccess: () => { refresh(); setOpen(false); },
  });

  return (
    <div className="ref-slot" data-slot={slot}>
      <div className="ref-slot__art">{current ? <img src={imageUrl(current)} alt="" /> : <UserRound size={24} strokeWidth={1.25} aria-hidden />}</div>
      <div className="ref-slot__bar">
        <span className="ref-slot__label">{name}</span>
        <IconButton ref={pickRef} icon={ChevronDown} size="sm" label={`Choose ${name.toLowerCase()} image`} disabled={images.length === 0} onClick={() => setOpen((o) => !o)} />
        <IconButton icon={Upload} size="sm" label={`Upload ${name.toLowerCase()} image`} busy={upload.isPending} onClick={() => fileRef.current?.click()} />
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
      <Popover anchor={pickRef} open={open} onClose={() => setOpen(false)} align="end" label={`${name} images`}>
        <div className="variant-grid variant-grid--small">
          {images.map((img) => (
            <button key={img.id} type="button" className={cx('variant__pick', img.id === current && 'is-picked')} aria-pressed={img.id === current}
              aria-label={`Use as ${name.toLowerCase()}`} data-tip={`Use as ${name.toLowerCase()}`} onClick={() => pick.mutate(img.id)}>
              <img src={imageUrl(img.id)} alt="" />
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
