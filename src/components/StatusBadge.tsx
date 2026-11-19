import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { IssueStatus } from "@/lib/nip34";
import { statusConfig, prStatusOverrides } from "@/lib/statusConfig";

interface StatusBadgeProps {
  status: IssueStatus;
  className?: string;
  /**
   * When "pr", uses PR-specific labels and icons (e.g. "Merged" instead of
   * "Resolved").
   * Default: "issue".
   */
  variant?: "issue" | "pr";
}

/** Renders only the icon for a given status, with the status colour applied. */
export function StatusIcon({
  status,
  variant = "issue",
  className,
}: {
  status: IssueStatus;
  variant?: "issue" | "pr";
  className?: string;
}) {
  const config = statusConfig[status];
  const override = variant === "pr" ? prStatusOverrides[status] : undefined;
  const Icon = override?.icon ?? config.icon;
  // Extract the text-colour classes so the icon is coloured correctly.
  const colourClass = (override?.className ?? config.className)
    .split(" ")
    .filter((c) => c.startsWith("text-") || c.startsWith("dark:text-"))
    .join(" ");
  return <Icon className={cn("h-3.5 w-3.5", colourClass, className)} />;
}

export function StatusBadge({
  status,
  className,
  variant = "issue",
}: StatusBadgeProps) {
  const config = statusConfig[status];
  const override = variant === "pr" ? prStatusOverrides[status] : undefined;
  const Icon = override?.icon ?? config.icon;
  const label = override?.label ?? config.label;

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-medium transition-colors",
        override?.className ?? config.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}
