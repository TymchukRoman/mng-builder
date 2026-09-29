/** Contract E. Each command applies one API change and knows its inverse. */
export interface EditorCommand {
  label: string;
  /** The page the command changes; the editor shows that page when undo or redo runs the command. */
  pageId?: string;
  apply(): Promise<void>;
  revert(): Promise<void>;
}

export interface FrameCreateCommand extends EditorCommand {
  /** Id of the frame the latest apply() created; null before the first apply. */
  readonly createdId: string | null;
}
