import { confirmLocalNetworkAccess } from "@/lib/localNetwork";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ensureWebSocketURL } from "applesauce-core/helpers";
import { normalizeUrl } from "@/lib/url";

export function NewRelayForm({
  onAdd,
}: {
  onAdd: (relay: string) => void | Promise<void>;
}) {
  const [newRelay, setNewRelay] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleAdd = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    setAdding(true);
    setError("");
    try {
      const relay = normalizeUrl(ensureWebSocketURL(newRelay.trim()));
      if (!(await confirmLocalNetworkAccess(relay, "relay"))) return;
      await onAdd(relay);
      setNewRelay("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add relay");
    } finally {
      setAdding(false);
    }
  };

  return (
    <form className="flex w-full min-w-0 flex-wrap gap-2" onSubmit={handleAdd}>
      <Input
        type="text"
        placeholder="wss://relay.example.com"
        value={newRelay}
        onChange={(e) => setNewRelay(e.target.value)}
        onKeyDown={handleKeyPress}
        className="min-w-0 flex-1"
        disabled={adding}
      />
      <Button
        type="submit"
        disabled={!newRelay.trim() || adding}
        className="shrink-0"
      >
        Add
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error} Edit the URL or retry Add.
        </p>
      )}
    </form>
  );
}
