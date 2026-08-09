"use client";

/**
 * Magic-link sign-in — PHASE-2.md §1. No password: this is a single-user
 * personal tool, so the whole point of an account is "see my history on
 * another device," not access control between multiple people.
 */

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/db/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (signInError) {
      setStatus("error");
      setError(signInError.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-8">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="font-[family-name:var(--font-display)] text-2xl text-trace">
            keysense
          </h1>
          <p className="label-type text-muted-foreground">
            sign in to sync your history
          </p>
        </div>

        {status === "sent" ? (
          <p
            role="status"
            className="label-type text-center text-vital"
          >
            check {email} for a sign-in link
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={status === "error"}
              />
            </div>

            {status === "error" && error && (
              <p role="alert" className="label-type text-flag">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" disabled={status === "sending" || !email}>
              {status === "sending" ? "sending…" : "send magic link"}
            </Button>
          </form>
        )}

        <p className="label-type text-center text-muted-foreground">
          typing works without an account — results stay on this device
          until you sign in.
        </p>
      </div>
    </main>
  );
}
