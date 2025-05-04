// @ts-check
// Cloudflare Worker Email Handler
// Inline type definitions for Env, EmailMessage, and ExecutionContext

/**
 * Minimal Env type for Cloudflare Worker environment variables.
 * Only the domain is expected.
 * @typedef {Object} Env
 * @property {string} MAIL_ENDPOINT_DOMAIN
 */

/**
 * Minimal EmailMessage type for Cloudflare Email Workers.
 * @typedef {Object} EmailMessage
 * @property {ReadableStream<Uint8Array>} raw
 * @property {string} from
 */

/**
 * Minimal ExecutionContext type for Cloudflare Workers.
 * @typedef {Object} ExecutionContext
 * @property {(promise: Promise<unknown>) => void} waitUntil
 */

/**
 * Cloudflare Email Worker: receives incoming emails and forwards them to the SvelteKit mail endpoint.
 * The endpoint domain is provided via MAIL_ENDPOINT_DOMAIN environment variable.
 * The path is hardcoded to '/api/mail'.
 * @type {{ email: (message: EmailMessage, env: Env, ctx: ExecutionContext) => Promise<void> }}
 */
export default {
  /**
   * Handles incoming email events.
   * @param {EmailMessage} message
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<void>}
   */
  async email(/** @type {EmailMessage} */ message, /** @type {Env} */ env) {
    const domain = env.MAIL_ENDPOINT_DOMAIN;
    if (!domain) {
      console.error("MAIL_ENDPOINT_DOMAIN not set in environment");
      return;
    }
    const endpoint = `https://${domain}/api/mail`;
    try {
      // message.raw is a ReadableStream<Uint8Array>
      const rawBuffer = await streamToArrayBuffer(message.raw);
      const sender = message.from;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-sender": sender,
        },
        body: rawBuffer,
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`Mail forward failed: ${res.status} ${text}`);
      }
    } catch (error) {
      console.error("Cloudflare email worker error:", error);
    }
  },
};

/**
 * Utility to convert a ReadableStream<Uint8Array> to ArrayBuffer.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<ArrayBuffer>}
 */
async function streamToArrayBuffer(
  /** @type {ReadableStream<Uint8Array>} */ stream,
) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}
