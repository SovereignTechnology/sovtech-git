import { useCallback, useMemo, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { Trash2 } from "lucide-react";
import { DeleteSoftwareRelease } from "@/actions/softwareReleaseActions";
import type {
  SoftwareApplication,
  SoftwareAsset,
  SoftwareRelease,
} from "@/casts/Software";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useRecoveryToast } from "@/hooks/useRecoveryToast";
import { runner } from "@/services/actions";

const APK_MIME_TYPE = "application/vnd.android.package-archive";

function isAndroidPlatform(platform: string): boolean {
  return platform.toLowerCase().startsWith("android");
}

/**
 * Trash button + confirmation dialog for a software release. Rendered only
 * for the release's publisher, since relays honour NIP-09 requests solely
 * from the original author.
 */
export function DeleteReleaseButton({
  release,
  application,
  assetsById,
  repoCoords,
  onDeleted,
}: {
  release: SoftwareRelease;
  application: SoftwareApplication | undefined;
  assetsById: Map<string, SoftwareAsset>;
  repoCoords: string[];
  onDeleted?: () => void;
}) {
  const account = useActiveAccount();
  const { toast } = useRecoveryToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [includeAssets, setIncludeAssets] = useState(true);
  const [deleting, setDeleting] = useState(false);

  // Only assets signed by the publisher can be deleted by this request.
  const ownAssets = useMemo(
    () =>
      release.assets.flatMap(({ id }) => {
        const asset = assetsById.get(id);
        return asset && asset.event.pubkey === release.pubkey ? [asset] : [];
      }),
    [release, assetsById],
  );

  const isAndroid = useMemo(
    () =>
      (application?.platforms.some(isAndroidPlatform) ?? false) ||
      release.assets.some(({ id }) => {
        const asset = assetsById.get(id);
        return (
          !!asset &&
          (asset.mimeType === APK_MIME_TYPE ||
            asset.platforms.some(isAndroidPlatform))
        );
      }),
    [application, release, assetsById],
  );

  const reset = useCallback(() => {
    setOpen(false);
    setReason("");
    setIncludeAssets(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runner.run(DeleteSoftwareRelease, release.event, {
        repoCoords,
        assets: includeAssets ? ownAssets.map((asset) => asset.event) : [],
        includeZapstore: isAndroid,
        reason: reason.trim() || undefined,
      });
      reset();
      onDeleted?.();
    } catch (err) {
      const previousReason = reason;
      const previousIncludeAssets = includeAssets;
      reset();
      toast({
        title: "Could not delete release",
        description: err instanceof Error ? err.message : "Request failed",
        variant: "destructive",
        recovery: {
          label: "Review deletion",
          action: () => {
            setReason(previousReason);
            setIncludeAssets(previousIncludeAssets);
            setOpen(true);
          },
        },
      });
    } finally {
      setDeleting(false);
    }
  }, [
    deleting,
    release.event,
    repoCoords,
    includeAssets,
    ownAssets,
    isAndroid,
    reason,
    reset,
    onDeleted,
    toast,
  ]);

  if (!account || account.pubkey !== release.pubkey) return null;

  const idPrefix = `delete-release-${release.event.id.slice(0, 8)}`;
  const assetCount = ownAssets.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center text-xs text-muted-foreground/50 hover:text-destructive transition-colors px-1.5 py-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Delete release"
        title="Delete release"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      <AlertDialog open={open} onOpenChange={(v) => !v && reset()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete release {release.version}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will send a deletion request (NIP-09) to your outbox relays,
              the repository relays
              {isAndroid ? ", and Zapstore" : ""}. Not all relays honour
              deletion requests — the release may remain visible on some
              clients.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {assetCount > 0 && (
            <label
              htmlFor={`${idPrefix}-assets`}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-3 py-3"
            >
              <Checkbox
                id={`${idPrefix}-assets`}
                checked={includeAssets}
                onCheckedChange={(value) => setIncludeAssets(!!value)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <span className="text-sm font-medium">
                  Also delete {assetCount} software{" "}
                  {assetCount === 1 ? "asset" : "assets"}
                </span>
                <p className="text-xs text-muted-foreground">
                  Include the asset events referenced by this release in the
                  deletion request. Files on Blossom servers are not removed.
                </p>
              </div>
            </label>
          )}
          <div className="space-y-1.5 py-1">
            <Label htmlFor={`${idPrefix}-reason`} className="text-sm">
              Reason{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Textarea
              id={`${idPrefix}-reason`}
              placeholder="Why are you deleting this release?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="resize-none text-sm"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={reset} disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Sending…" : "Send deletion request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
