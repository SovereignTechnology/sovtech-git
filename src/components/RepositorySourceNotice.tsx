import { useRepositoryOutboxOnly } from "@/hooks/useRepositoryOutboxOnly";
import { useRepositoryCuration } from "@/hooks/useRepositoryCuration";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** A found item may still be awaiting repository-relay confirmation. */
export function RepositorySourceNotice({
  eventId,
  onExpand,
}: {
  eventId: string | undefined;
  onExpand: () => void;
}) {
  const { mode } = useRepositoryCuration();
  const outsideRepository = useRepositoryOutboxOnly(eventId, mode === "repo");
  if (!outsideRepository) return null;
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-4 py-12 text-center">
        <p>
          This item was found on other relays, but not on the repository relays.
        </p>
        <Button variant="outline" onClick={onExpand}>
          Include outbox relays
        </Button>
      </CardContent>
    </Card>
  );
}
