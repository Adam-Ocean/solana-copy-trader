import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-sm text-[12px] font-semibold tracking-wide ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary/80 text-primary-foreground hover:bg-primary/90 border border-white/10 shadow-sm",
        destructive: "bg-red-600 text-white hover:bg-red-500/90 border border-red-500/40 shadow-sm",
        outline: "border border-white/10 bg-[#12141a] hover:bg-white/5 text-white",
        secondary: "bg-[#1a1c24] text-gray-200 hover:bg-[#212432] border border-white/10",
        ghost: "hover:bg-white/5 text-gray-200",
        link: "text-primary underline-offset-4 hover:underline",
        buy: "bg-gradient-to-r from-emerald-500/20 to-green-600/20 text-emerald-300 border border-emerald-400/30 hover:from-emerald-500/30 hover:to-green-600/30 shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_0_12px_rgba(16,185,129,0.08)]",
        sell: "bg-gradient-to-r from-rose-500/20 to-red-600/20 text-red-300 border border-red-400/30 hover:from-rose-500/30 hover:to-red-600/30 shadow-[0_0_0_1px_rgba(244,63,94,0.18),0_0_12px_rgba(244,63,94,0.08)]",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2",
        lg: "h-10 px-6",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }