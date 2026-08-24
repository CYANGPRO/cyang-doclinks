"use client";

import { useEffect, useState } from "react";
import { UserFacingErrorDialog } from "@/components/UserFacingErrorDialog";
import {
  actionProblemFor,
  offlineProblem,
  unexpectedClientProblem,
  type UserFacingProblem,
} from "@/lib/user-facing-errors";

export function GlobalErrorExperience() {
  const [problem, setProblem] = useState<UserFacingProblem | null>(null);

  useEffect(() => {
    const handledAlerts = new WeakMap<Element, string>();
    const presentAlert = (element: Element) => {
      if (!element.matches('.form-message[role="alert"]')) return;
      const message = element.textContent?.trim() ?? "";
      if (!message || handledAlerts.get(element) === message) return;
      handledAlerts.set(element, message);
      setProblem(actionProblemFor(message));
    };
    const inspect = (node: Node) => {
      if (node instanceof Element) {
        presentAlert(node);
        node.querySelectorAll('.form-message[role="alert"]').forEach(presentAlert);
      } else if (node.parentElement) {
        presentAlert(node.parentElement);
      }
    };
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        inspect(record.target);
        record.addedNodes.forEach(inspect);
      });
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    document.querySelectorAll('.form-message[role="alert"]').forEach(presentAlert);

    const handleOffline = () => setProblem(offlineProblem);
    const handleRuntimeError = () => setProblem(unexpectedClientProblem);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("error", handleRuntimeError);
    window.addEventListener("unhandledrejection", handleRuntimeError);
    return () => {
      observer.disconnect();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("error", handleRuntimeError);
      window.removeEventListener("unhandledrejection", handleRuntimeError);
    };
  }, []);

  return <UserFacingErrorDialog problem={problem} onClose={() => setProblem(null)} />;
}
