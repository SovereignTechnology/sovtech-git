import { cva, type VariantProps } from "class-variance-authority";

/** Optional badge backgrounds for references embedded in contextual surfaces. */
export const badgeBackground = cva("", {
  variants: {
    backgroundVariant: {
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      amber:
        "bg-amber-900/[0.0875] text-amber-950 hover:bg-amber-900/[0.1375] focus-visible:ring-amber-700 dark:bg-amber-200/[0.0875] dark:text-amber-100 dark:hover:bg-amber-200/[0.1375] dark:focus-visible:ring-amber-400",
    },
  },
});

export type BadgeBackgroundVariant = NonNullable<
  VariantProps<typeof badgeBackground>["backgroundVariant"]
>;
