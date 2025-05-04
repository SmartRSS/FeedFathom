import { EmailProcessor } from "$lib/email-processor";
import { EmailHandler } from "$lib/email/email-handler";
import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

function isMailJsonBody(_body: unknown): _body is { raw: string } {
  return (
    typeof _body === "object" &&
    _body !== null &&
    Object.prototype.hasOwnProperty.call(_body, "raw") &&
    typeof (_body as { raw: unknown }).raw === "string"
  );
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const { articlesRepository, sourcesRepository } = locals.dependencies;
  const emailHandler = new EmailHandler(
    new EmailProcessor(),
    sourcesRepository,
    articlesRepository,
  );
  let raw: Buffer | undefined;

  // Accept either raw RFC822 or JSON { raw: base64 }
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.startsWith("application/json")) {
      const body = await request.json();
      if (!isMailJsonBody(body)) {
        return json(
          { error: "Missing 'raw' field in JSON body" },
          { status: 400 },
        );
      }
      raw = Buffer.from(body.raw, "base64");
    } else if (
      contentType.startsWith("message/rfc822") ||
      contentType.startsWith("application/octet-stream")
    ) {
      raw = Buffer.from(await request.arrayBuffer());
    } else {
      return json({ error: "Unsupported content type" }, { status: 400 });
    }

    const parsed = await emailHandler.parseEmail(raw);
    // For HTTP, sender must be provided in a header or JSON field
    const sender =
      request.headers.get("x-sender") ?? parsed.from?.value[0]?.address;
    if (!sender) {
      return json({ error: "Missing sender address" }, { status: 400 });
    }
    await emailHandler.processParsedEmail(parsed, sender);
    return json({ ok: true });
  } catch (error: unknown) {
    // Log error and return appropriate status
    // TODO: Use project logging utility
    console.error("Mail endpoint error:", error);
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 500 });
    }
    return json({ error: "Unknown error" }, { status: 500 });
  }
};
