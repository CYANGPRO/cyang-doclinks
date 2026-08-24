"use client";

import { useRouter } from "next/navigation";

export function CursorBackButton({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  return <button className="button secondary" type="button" onClick={() => {
    if (window.history.length > 1) router.back();
    else router.push(fallbackHref);
  }}>Previous page</button>;
}
