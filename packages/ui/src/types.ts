import type { z } from 'zod';
import type {
  CreateChapterSchema, CreateCharacterSchema, CreateFrameSchema, CreateMangaSchema, CreatePageSchema,
  GeneratePanelSchema, UpdateChapterSchema, UpdateCharacterSchema, UpdateFrameSchema, UpdateMangaSchema,
  UpdatePanelSchema,
} from '@manga/shared';

/** Request bodies use each schema's *input* type, so fields with defaults stay optional. */
export type CreateMangaBody = z.input<typeof CreateMangaSchema>;
export type UpdateMangaBody = z.input<typeof UpdateMangaSchema>;
export type CreateCharacterBody = z.input<typeof CreateCharacterSchema>;
export type UpdateCharacterBody = z.input<typeof UpdateCharacterSchema>;
export type CreateChapterBody = z.input<typeof CreateChapterSchema>;
export type UpdateChapterBody = z.input<typeof UpdateChapterSchema>;
export type CreatePageBody = z.input<typeof CreatePageSchema>;
export type UpdatePanelBody = z.input<typeof UpdatePanelSchema>;
export type CreateFrameBody = z.input<typeof CreateFrameSchema>;
export type UpdateFrameBody = z.input<typeof UpdateFrameSchema>;
export type GeneratePanelBody = z.input<typeof GeneratePanelSchema>;
