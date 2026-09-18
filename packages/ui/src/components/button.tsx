import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          // Disabled is a FLAT inert surface, not the base fill at 50%. With a pure
          // black primary, `opacity-50` paints a mid-grey button with white text -
          // which reads as a second, lesser ENABLED button rather than a disabled
          // one. A muted surface with muted ink is unmistakable, and it stays on
          // the palette instead of inventing a tone between the two ends.
          // ACCENT, not --primary. These two lived apart: 61 hand-rolled primary
          // buttons use `bg-brand`, while every <Button> default sat on
          // `--primary` - so under a non-neutral accent the Save button in
          // Settings would have stayed pure ink beside a coloured one in chat.
          // --primary cannot simply be accented instead: it is the app's body
          // ink behind ~494 text-primary usages, so tinting it would colour all
          // prose. One variant moves; 14 consumers inherit.
          "bg-brand text-brand-foreground hover:bg-brand/90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
