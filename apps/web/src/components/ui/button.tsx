import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function variantClass(variant: ButtonVariant) {
  if (variant === "ghost") return "button--ghost";
  if (variant === "secondary") return "secondary";
  if (variant === "danger") return "button--danger";
  return undefined;
}

export function Button({ className, variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={classNames("button", variantClass(variant), className)} {...props} />;
}

export function ButtonLink({ className, variant = "primary", href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; variant?: ButtonVariant }) {
  return <Link className={classNames("button", variantClass(variant), className)} href={href} {...props} />;
}
