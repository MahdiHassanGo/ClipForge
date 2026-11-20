import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]",
        outline:
          "border border-border/80 bg-card hover:bg-secondary hover:text-foreground",
        secondary:
          "border border-border/60 bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-secondary/60 hover:text-foreground",
      },
      size: {
        default: "h-9 px-3.5 py-1.5 text-sm",
        sm: "h-7 rounded-md px-2.5 text-xs",
        lg: "h-10 rounded-md px-5 text-sm",
        icon: "h-8 w-8",
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
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  ),
);
Button.displayName = "Button";
