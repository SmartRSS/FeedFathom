import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import manifestTemplate from "../src/extension/manifest.json";

type ExtensionManifest = typeof manifestTemplate;
type BrowserTarget = "chromium" | "firefox";
type ProjectionOptions = {
  chromiumUpdateUrl?: string;
  firefoxUpdateUrl?: string;
  version?: string;
};

const root = path.resolve(import.meta.dir, "..");
const extensionSource = path.join(root, "src/extension");
// Icons are shared with the SPA rather than copied into the extension source.
const iconSource = path.join(root, "src/spa/assets");
// Not named in the manifest: background-event.ts sets it as the toolbar
// popup at runtime, on browsers without a contextMenus API.
const runtimePages = ["popup.html"];
const extensionDirectory = path.join(root, "ext");
const targetDirectories: Record<BrowserTarget, string> = {
  chromium: path.join(extensionDirectory, "build-ch"),
  firefox: path.join(extensionDirectory, "build-ff"),
};

const portableExtensionVersion = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$/;

function extensionVersion(value: string): string {
  if (
    !portableExtensionVersion.test(value) ||
    value.split(".").some((part) => Number(part) > 65_535)
  ) {
    throw new Error(`Invalid extension version: ${value}`);
  }
  return value;
}

function updateUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("Invalid update URL", { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    value.includes("#")
  ) {
    throw new Error("Invalid update URL");
  }
  return parsed.href;
}

export function projectExtensionManifest(
  template: ExtensionManifest,
  target: BrowserTarget,
  options: ProjectionOptions = {},
) {
  const manifest = structuredClone(template);
  const version = extensionVersion(options.version ?? manifest.version);
  const { background, browser_specific_settings, ...shared } = manifest;

  if (target === "chromium") {
    const { scripts: _scripts, ...chromiumBackground } = background;
    return {
      ...shared,
      background: chromiumBackground,
      ...(options.chromiumUpdateUrl
        ? { update_url: updateUrl(options.chromiumUpdateUrl) }
        : {}),
      version,
    };
  }

  const { service_worker: _serviceWorker, ...firefoxBackground } = background;
  return {
    ...shared,
    background: firefoxBackground,
    browser_specific_settings: {
      ...browser_specific_settings,
      gecko: {
        ...browser_specific_settings.gecko,
        ...(options.firefoxUpdateUrl
          ? { update_url: updateUrl(options.firefoxUpdateUrl) }
          : {}),
      },
    },
    version,
  };
}

// Everything the package needs, read from the manifest and the pages it
// names, so adding a script, page or stylesheet takes one edit. Each bundled
// script is built from the TypeScript module of the same name.
export async function packagedFiles(manifest: ExtensionManifest) {
  const scripts = new Set([
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((script) => script.js),
  ]);
  const pages = [manifest.options_ui.page, ...runtimePages];
  const staticFiles = new Set(pages);
  for (const page of pages) {
    const html = await Bun.file(path.join(extensionSource, page)).text();
    new HTMLRewriter()
      .on("script[src]", {
        element(element) {
          scripts.add(element.getAttribute("src") ?? "");
        },
      })
      .on('link[rel="stylesheet"][href]', {
        element(element) {
          staticFiles.add(element.getAttribute("href") ?? "");
        },
      })
      .transform(html);
  }
  return {
    entrypoints: Array.from(scripts, (script) =>
      path.join(extensionSource, script.replace(/\.js$/, ".ts")),
    ),
    icons: Object.values(manifest.icons),
    staticFiles: [...staticFiles],
  };
}

async function buildTarget(
  target: BrowserTarget,
  options: ProjectionOptions,
): Promise<void> {
  const directory = targetDirectories[target];
  await rm(directory, { force: true, recursive: true });
  const files = await packagedFiles(manifestTemplate);
  const result = await Bun.build({
    entrypoints: files.entrypoints,
    outdir: directory,
    target: "browser",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Extension bundle failed");
  }

  for (const name of files.icons) {
    await copyFile(path.join(iconSource, name), path.join(directory, name));
  }
  for (const name of files.staticFiles) {
    await copyFile(
      path.join(extensionSource, name),
      path.join(directory, name),
    );
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(projectExtensionManifest(manifestTemplate, target, options), null, 2)}\n`,
  );
}

export async function main(
  options: ProjectionOptions = {
    ...(process.env["CHROMIUM_UPDATE_URL"]
      ? { chromiumUpdateUrl: process.env["CHROMIUM_UPDATE_URL"] }
      : {}),
    ...(process.env["FIREFOX_UPDATE_URL"]
      ? { firefoxUpdateUrl: process.env["FIREFOX_UPDATE_URL"] }
      : {}),
    ...(process.env["EXTENSION_VERSION"]
      ? { version: process.env["EXTENSION_VERSION"] }
      : {}),
  },
): Promise<void> {
  await mkdir(extensionDirectory, { recursive: true });
  await Promise.all([
    buildTarget("chromium", options),
    buildTarget("firefox", options),
  ]);
}

if (import.meta.main) {
  await main();
}
