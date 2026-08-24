"use client";

import { useState } from "react";
import { UserFacingErrorDialog } from "@/components/UserFacingErrorDialog";
import type { UserFacingProblem } from "@/lib/user-facing-errors";

export function SignInErrorDialog({ initialProblem }: { initialProblem: UserFacingProblem | null }) {
  const [problem, setProblem] = useState(initialProblem);
  return <UserFacingErrorDialog problem={problem} onClose={() => setProblem(null)} />;
}
