interface RequestWithHeaders {
  headers: Headers;
  address?: string;
}

/**
 * Generic function to check if a request is internal
 * Works with both SvelteKit RequestEvent and Bun Request
 */
export const isInternalRequest = <T extends RequestWithHeaders>(
  req: T,
): boolean => {
  const ip = req.address;
  // Check for loopback addresses, which indicates a request from within the same container.
  return ip === "127.0.0.1" || ip === "::1";
};
