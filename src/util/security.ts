interface RequestWithHeaders {
  headers: Headers;
  address?: string;
}

/**
 * Generic function to check if a request is internal
 * Works with both SvelteKit RequestEvent and Bun Request
 */
export const isInternalRequest = <T extends RequestWithHeaders>(
  _req: T,
): boolean => {
  return true;
  // TODO
  //   const forwardedFor = req.headers.get("x-forwarded-for");
  //   const realIp = req.headers.get("x-real-ip");

  //   // If there are any forwarded headers, request is coming through a proxy
  //   if (forwardedFor || realIp) {
  //     return false;
  //   }

  //   // Try to get IP using available methods

  //   if (req.address) {
  //     return req.address === "127.0.0.1" || req.address === "::1";
  //   }

  //   // For requests without IP check capability, we can only check headers
  //   // Note: This is less secure than the version with IP check
  //   return true;
};
