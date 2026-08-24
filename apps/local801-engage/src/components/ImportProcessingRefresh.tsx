"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const terminalStages = new Set(["ready_for_review", "failed", "cancelled"]);

export function ImportProcessingRefresh({ active, batchId }: { active: boolean; batchId: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: number | null = null;

    async function poll() {
      try {
        const response = await fetch(`/api/imports/${encodeURIComponent(batchId)}/status`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const body = await response.json() as { processingStage?: unknown };
          if (typeof body.processingStage === "string" && terminalStages.has(body.processingStage)) {
            router.refresh();
            return;
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 5000);
    }

    timer = window.setTimeout(() => void poll(), 3000);
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, batchId, router]);
  return null;
}
