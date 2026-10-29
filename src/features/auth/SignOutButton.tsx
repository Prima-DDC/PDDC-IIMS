"use client";

import { useTransition } from "react";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui";
import { signOut } from "./actions";

export function SignOutButton({
  tone = "secondary",
  size = "sm",
  label = "Sign out",
}: {
  tone?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  label?: string;
}) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      tone={tone}
      size={size}
      disabled={pending}
      onClick={() => start(() => void signOut())}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <LogOut className="size-4" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}
