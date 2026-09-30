import EmojiPicker, { EmojiStyle } from "emoji-picker-react";
import "./ReactionEmojiPicker.css";

export default function ReactionEmojiPickerContent({
  onSelect,
}: {
  onSelect: (emoji: string) => void;
}) {
  return (
    <EmojiPicker
      className="reaction-emoji-picker"
      emojiStyle={EmojiStyle.NATIVE}
      width="100%"
      height="min(450px, var(--radix-popover-content-available-height, 70vh))"
      searchPlaceholder="Search emojis…"
      previewConfig={{ showPreview: false }}
      onEmojiClick={({ emoji }) => onSelect(emoji)}
    />
  );
}
