import { expect, test } from "bun:test";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { getFaviconHandler } from "#features/feeds/routes/favicon.ts";

const serve = (dataUrl: string) =>
  getFaviconHandler(
    { params: { id: "1" }, status: (code) => code },
    {
      sourcesDataService: strictFake<SourcesDataService>({
        getFavicon: async () => dataUrl,
      }),
    },
  );

test("serves an image with a restrictive CSP and nosniff", async () => {
  const response = await serve("data:image/svg+xml;base64,PHN2Zy8+");
  if (!(response instanceof Response)) throw new Error("Expected a Response");
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("<svg/>");
});

test("strips parameters from a stored image type", async () => {
  const response = await serve("data:image/png; charset=x;base64,AAAA");
  if (!(response instanceof Response)) throw new Error("Expected a Response");
  expect(response.headers.get("content-type")).toBe("image/png");
});

test("refuses a non-image type", async () => {
  expect(await serve("data:text/html;base64,PGgxPg==")).toBe(404);
});
