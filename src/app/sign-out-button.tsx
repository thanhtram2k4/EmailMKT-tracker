"use client";
import { useRouter } from "next/navigation";
import { authClient } from "../lib/auth/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="btn"
      data-testid="sign-out"
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
