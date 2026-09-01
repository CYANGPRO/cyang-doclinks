import "server-only";

import { Resend } from "resend";

export type SendMemberEmailPreviewTestInput = {
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

export async function sendMemberEmailPreviewTest(input: SendMemberEmailPreviewTestInput) {
  const resend = new Resend(input.apiKey);
  const { data, error } = await resend.emails.send({
    from: input.from,
    replyTo: input.replyTo,
    to: [input.to],
    subject: input.subject,
    text: input.text,
    html: input.html,
  }, { idempotencyKey: input.idempotencyKey });
  if (error || !data?.id) throw new Error("Resend did not accept the CAT Preview test email.");
  return { providerMessageId: data.id };
}
