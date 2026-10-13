import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-md hover:shadow-lg hover:bg-primary/90 hover:-translate-y-0.5",
        destructive:
          "bg-destructive text-destructive-foreground shadow-md hover:shadow-lg hover:bg-destructive/90 hover:-translate-y-0.5",
        outline:
          "border border-border/50 bg-background/50 backdrop-blur-sm hover:bg-muted/50 hover:border-border shadow-sm hover:shadow-md",
        secondary:
          "bg-secondary/80 text-secondary-foreground backdrop-blur-sm hover:bg-secondary shadow-sm hover:shadow-md hover:-translate-y-0.5",
        ghost:
          "hover:bg-muted/50 hover:text-accent-foreground",
        link:
          "text-primary underline-offset-4 hover:underline",
        glass:
          "bg-card/50 backdrop-blur-xl border border-border/30 text-foreground shadow-glass hover:bg-card/70 hover:shadow-glass-lg hover:-translate-y-0.5",
      },
      size: {
        default: "h-11 px-5 py-2.5",
        sm: "h-9 rounded-lg px-4",
        lg: "h-12 rounded-xl px-8 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
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
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
