import type { FrameKind } from '@manga/shared';
import { Cloud, Heading1, MessageCircle, RectangleHorizontal, Type, Zap, type LucideIcon } from '../ui/icons';

export const FRAME_KIND_ICON: Record<FrameKind, LucideIcon> = {
  speech: MessageCircle, thought: Cloud, shout: Zap, narration: RectangleHorizontal, sfx: Type, title: Heading1,
};

export const FRAME_KIND_LABEL: Record<FrameKind, string> = {
  speech: 'Speech bubble', thought: 'Thought bubble', shout: 'Shout', narration: 'Narration box', sfx: 'Sound effect', title: 'Title',
};
