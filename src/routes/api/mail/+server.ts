import { EmailHandler } from "$lib/email/email-handler";
import { EmailProcessor } from "$lib/email-processor";
import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import { type } from "arktype";
import { llog, logError } from "../../../util/log.ts";

const mailBody = type({
  from: "string.email",
  to: "string.email",
  subject: "string",
  raw: "string",
});

export type MailBody = typeof mailBody.infer;

export const POST: RequestHandler = async ({ request, locals }) => {
  const { articlesRepository, sourcesRepository } = locals.dependencies;
  const emailHandler = new EmailHandler(
    new EmailProcessor(),
    sourcesRepository,
    articlesRepository,
  );

  try {
    const body = mailBody(await request.json());
    if (body instanceof type.errors) {
      return json({ error: "Invalid body" }, { status: 400 });
    }

    const parsed = await emailHandler.parseEmail(
      Buffer.from(body.raw, "utf-8"),
    );
    llog(JSON.stringify(parsed, null, 2));
    const sender = body.from;

    await emailHandler.processParsedEmail(parsed, sender);
    return json({ ok: true });
  } catch (error: unknown) {
    // Log error and return appropriate status
    logError("Mail endpoint error:", error);
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 500 });
    }
    return json({ error: "Unknown error" }, { status: 500 });
  }
};
