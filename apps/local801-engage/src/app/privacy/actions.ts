"use server";

import { redirect } from "next/navigation";
import { getPolicyAcknowledgementUser, getPreviewUser } from "@/lib/authz.server";
import { acceptCurrentAccessPolicy } from "@/lib/policy-acknowledgement";
import { safePolicyReturnPath } from "@/lib/policy-return-path";

function policyUrl(nextPath: string, error: "required" | "unavailable") {
  const query = new URLSearchParams({ next: nextPath, error });
  return `/privacy?${query.toString()}`;
}

export async function acknowledgePrivacyAndAcceptableUse(formData: FormData) {
  const nextPath = safePolicyReturnPath(formData.get("next"));
  if (formData.get("accepted") !== "yes") redirect(policyUrl(nextPath, "required"));

  const pendingUser = await getPolicyAcknowledgementUser();
  if (!pendingUser) {
    if (await getPreviewUser()) redirect(nextPath);
    redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }

  let failed = false;
  try {
    if (pendingUser.sessionVersion === null) throw new Error("Production session version is unavailable.");
    await acceptCurrentAccessPolicy({
      organizationSlug: pendingUser.organizationId,
      userId: pendingUser.id,
      sessionVersion: pendingUser.sessionVersion,
    });
  } catch {
    failed = true;
  }
  if (failed) redirect(policyUrl(nextPath, "unavailable"));
  redirect(nextPath);
}
