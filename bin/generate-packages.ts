import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import manifestTemplate from "../src/extension/manifest.json";

type ExtensionManifest = typeof manifestTemplate & {
  browser_specific_settings: typeof manifestTemplate.browser_specific_settings & {
    gecko: typeof manifestTemplate.browser_specific_settings.gecko & {
      update_url?: string;
    };
  };
};
type BrowserTarget = "chromium" | "firefox";
type ProjectionOptions = {
  chromiumUpdateUrl?: string;
  firefoxUpdateUrl?: string;
  version?: string;
};

const root = path.resolve(import.meta.dir, "..");
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
  const { update_url: _updateUrl, ...gecko } = browser_specific_settings.gecko;
  return {
    ...shared,
    background: firefoxBackground,
    browser_specific_settings: {
      ...browser_specific_settings,
      gecko: {
        ...gecko,
        ...(options.firefoxUpdateUrl
          ? { update_url: updateUrl(options.firefoxUpdateUrl) }
          : {}),
      },
    },
    version,
  };
}

async function buildTarget(
  target: BrowserTarget,
  options: ProjectionOptions,
): Promise<void> {
  const directory = targetDirectories[target];
  await rm(directory, { force: true, recursive: true });
  const result = await Bun.build({
    entrypoints: [
      path.join(root, "src/extension/background-event.ts"),
      path.join(root, "src/extension/content-script.ts"),
      path.join(root, "src/extension/options.ts"),
      path.join(root, "src/extension/popup.ts"),
    ],
    outdir: directory,
    target: "browser",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Extension bundle failed");
  }

  for (const name of [
    "48-inverted-round.png",
    "64-inverted-round.png",
    "96-inverted-round.png",
    "128-inverted-round.png",
  ]) {
    await copyFile(
      path.join(root, "src/spa/assets", name),
      path.join(directory, name),
    );
  }
  for (const name of ["extension.css", "options.html", "popup.html"]) {
    await copyFile(
      path.join(root, "src/extension", name),
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
