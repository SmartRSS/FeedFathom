import type { RequestHandler } from "@sveltejs/kit";
import { logError } from "../../../util/log.ts";

function sniffContentType(bytes: Uint8Array): string {
  // Check for PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // Check for GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  // Check for JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // Check for ICO
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return "image/x-icon";
  }
  // Check for SVG (look for SVG tag)
  const decoder = new TextDecoder();
  const header = decoder.decode(bytes.slice(0, 100));
  if (header.includes("<svg")) {
    return "image/svg+xml";
  }
  // Default to PNG if we can't determine the type
  return "image/png";
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return new Response(null, { status: 404 });
  }

  const sourceId = params["id"];
  if (!sourceId) {
    return new Response(null, { status: 404 });
  }

  try {
    const source = await locals.dependencies.sourcesRepository.findSourceById(
      Number.parseInt(sourceId, 10),
    );

    if (!source?.favicon) {
      return new Response(null, { status: 404 });
    }

    // Validate favicon data format
    if (!source.favicon.startsWith("data:image/")) {
      logError("Invalid favicon format for source", { sourceId });
      return new Response(null, { status: 404 });
    }

    const parts = source.favicon.split(",");
    if (parts.length !== 2) {
      logError("Invalid favicon data format for source", { sourceId });
      return new Response(null, { status: 404 });
    }

    const [, base64Data] = parts;
    if (!base64Data) {
      logError("Missing base64 data in favicon for source", { sourceId });
      return new Response(null, { status: 404 });
    }

    try {
      // Convert base64 to binary
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Sniff the content type from the binary data
      const contentType = sniffContentType(bytes);

      return new Response(bytes, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        } as HeadersInit,
      });
    } catch (error) {
      logError("Failed to decode base64 favicon for source", {
        sourceId,
        error,
      });
      return new Response(null, { status: 404 });
    }
  } catch (error) {
    logError("Error processing favicon request", { sourceId, error });
    return new Response(null, { status: 404 });
  }
};
