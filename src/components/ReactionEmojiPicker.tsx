import { lazy, Suspense, useState } from "react";
import { SmilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";

const EmojiPicker = lazy(
  () => import("@/components/ReactionEmojiPickerContent"),
);

export function ReactionEmojiPicker({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <SmilePlus className="mr-2 h-4 w-4" aria-hidden="true" />
          Search emojis
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        aria-label="Choose a reaction emoji"
        className="w-[min(350px,calc(100vw-16px))] overflow-hidden p-0"
      >
        <Suspense
          fallback={
            <div role="status" className="space-y-3 p-3">
              <span className="sr-only">Loading emojis…</span>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          }
        >
          <EmojiPicker
            onSelect={(emoji) => {
              setOpen(false);
              onSelect(emoji);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
