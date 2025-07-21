import { describe, expect, it } from "bun:test";
import { WebSubService } from "../src/lib/websub-service.ts";

describe("WebSub Preview", () => {
  it("should extract WebSub info from XML content", () => {
    const webSubService = new WebSubService(
      {} as any, // axiosInstance
      {} as any, // redis
      {} as any, // sourcesDataService
    );

    const xmlContent = `
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://example.com/feed</link>
          <link rel="hub" href="https://hub.example.com"/>
          <link rel="self" href="https://example.com/feed"/>
          <link rel="topic" href="https://example.com/feed"/>
        </channel>
      </rss>
    `;

    const webSubInfo = webSubService.extractWebSubInfo(xmlContent);
    
    expect(webSubInfo).not.toBeNull();
    expect(webSubInfo?.hub).toBe("https://hub.example.com");
    expect(webSubInfo?.self).toBe("https://example.com/feed");
    expect(webSubInfo?.topic).toBe("https://example.com/feed");
  });

  it("should return null for content without WebSub info", () => {
    const webSubService = new WebSubService(
      {} as any, // axiosInstance
      {} as any, // redis
      {} as any, // sourcesDataService
    );

    const xmlContent = `
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://example.com/feed</link>
        </channel>
      </rss>
    `;

    const webSubInfo = webSubService.extractWebSubInfo(xmlContent);
    
    expect(webSubInfo).toBeNull();
  });
}); 