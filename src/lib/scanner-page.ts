export type ScannerPage = {
  anchors: { href: string; text: string }[];
  baseUrl: string;
  bitchuteChannelName?: string | undefined;
  feedLinks: { href: string; title?: string | undefined }[];
  generator?: string | undefined;
  rootName: string;
  rootXmlns?: string | undefined;
  vimeoChannelHref?: string | undefined;
  youtubeChannelHref?: string | undefined;
};

export const scannerPageFromDocument = (
  address: string,
  document_: Document,
): ScannerPage => {
  const root =
    document_.querySelector("#webkit-xml-viewer-source-xml")
      ?.firstElementChild ?? document_.documentElement;
  const value = (selector: string, attribute: string) =>
    document_.querySelector(selector)?.getAttribute(attribute) ?? undefined;

  return {
    anchors: Array.from(document_.querySelectorAll("a"), (anchor) => ({
      href: anchor.getAttribute("href") ?? "",
      text: anchor.textContent ?? "",
    })),
    baseUrl: document_.baseURI || address,
    bitchuteChannelName:
      document_.querySelector(".owner>a")?.textContent ?? undefined,
    feedLinks: Array.from(
      document_.querySelectorAll(
        'link[type="application/rss+xml"], link[type="application/atom+xml"]',
      ),
      (link) => ({
        href: link.getAttribute("href") ?? "",
        title: link.getAttribute("title") ?? undefined,
      }),
    ),
    generator: value('meta[name="generator"]', "content"),
    rootName: root?.nodeName.toLowerCase() ?? "",
    rootXmlns: root?.getAttribute("xmlns") ?? undefined,
    vimeoChannelHref: value("a.js-user-link", "href"),
    youtubeChannelHref: value("#upload-info .ytd-channel-name>a", "href"),
  };
};

export const scannerPageFromHtml = (
  address: string,
  html: string,
): ScannerPage => {
  const anchors: ScannerPage["anchors"] = [];
  const feedLinks: ScannerPage["feedLinks"] = [];
  let activeAnchor: ScannerPage["anchors"][number] | undefined;
  let baseUrl = address;
  let bitchuteChannelName: string | undefined;
  let generator: string | undefined;
  let rootName = "";
  let rootXmlns: string | undefined;
  let vimeoChannelHref: string | undefined;
  let youtubeChannelHref: string | undefined;

  new HTMLRewriter()
    .on("*", {
      element(element) {
        if (rootName) return;
        rootName = element.tagName.toLowerCase();
        rootXmlns = element.getAttribute("xmlns") ?? undefined;
      },
    })
    .on("base[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (href && URL.canParse(href, address))
          baseUrl = new URL(href, address).href;
      },
    })
    .on('link[type="application/rss+xml"], link[type="application/atom+xml"]', {
      element(element) {
        feedLinks.push({
          href: element.getAttribute("href") ?? "",
          title: element.getAttribute("title") ?? undefined,
        });
      },
    })
    .on("a", {
      element(element) {
        activeAnchor = {
          href: element.getAttribute("href") ?? "",
          text: "",
        };
        anchors.push(activeAnchor);
      },
      text(text) {
        if (activeAnchor) activeAnchor.text += text.text;
      },
    })
    .on(".owner>a", {
      element() {
        bitchuteChannelName = "";
      },
      text(text) {
        bitchuteChannelName += text.text;
      },
    })
    .on('meta[name="generator"]', {
      element(element) {
        generator = element.getAttribute("content") ?? undefined;
      },
    })
    .on("a.js-user-link", {
      element(element) {
        vimeoChannelHref = element.getAttribute("href") ?? undefined;
      },
    })
    .on("#upload-info .ytd-channel-name>a", {
      element(element) {
        youtubeChannelHref = element.getAttribute("href") ?? undefined;
      },
    })
    .transform(html);

  return {
    anchors,
    baseUrl,
    bitchuteChannelName,
    feedLinks,
    generator,
    rootName,
    rootXmlns,
    vimeoChannelHref,
    youtubeChannelHref,
  };
};
