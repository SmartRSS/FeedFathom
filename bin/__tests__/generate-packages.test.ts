import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  packagedFiles,
  projectExtensionManifest,
} from "../generate-packages.ts";
import manifestTemplate from "../../src/extension/manifest.json";

const sourceManifest = () => structuredClone(manifestTemplate);

describe("extension package manifest projection", () => {
  test("projects a Chromium service-worker manifest", () => {
    const chromium = projectExtensionManifest(sourceManifest(), "chromium", {
      version: "2026.723.12.1",
    });

    expect(chromium.background).toEqual({
      service_worker: "background-event.js",
    });
    expect("browser_specific_settings" in chromium).toBe(false);
    expect(chromium.version).toBe("2026.723.12.1");
    expect("update_url" in chromium).toBe(false);
  });

  test("points released Chromium builds at their update manifest", () => {
    const chromium = projectExtensionManifest(sourceManifest(), "chromium", {
      chromiumUpdateUrl: "https://example.com/assets/updates.xml",
      firefoxUpdateUrl: "https://example.com/assets/updates.json",
    });

    expect(chromium).toMatchObject({
      update_url: "https://example.com/assets/updates.xml",
    });
    expect(JSON.stringify(chromium)).not.toContain("updates.json");
  });

  test("projects Firefox scripts and release metadata", () => {
    const firefox = projectExtensionManifest(sourceManifest(), "firefox", {
      firefoxUpdateUrl: "https://example.com/assets/updates.json",
      version: "2026.723.12.1",
    });
    if (!("browser_specific_settings" in firefox)) {
      throw new Error("Firefox settings missing");
    }

    expect(firefox.background).toEqual({ scripts: ["background-event.js"] });
    expect(firefox.browser_specific_settings.gecko).toEqual({
      ...manifestTemplate.browser_specific_settings.gecko,
      update_url: "https://example.com/assets/updates.json",
    });
    expect(firefox.version).toBe("2026.723.12.1");
  });

  test("omits Firefox update metadata from local builds", () => {
    const firefox = projectExtensionManifest(sourceManifest(), "firefox");
    if (!("browser_specific_settings" in firefox)) {
      throw new Error("Firefox settings missing");
    }

    expect("update_url" in firefox.browser_specific_settings.gecko).toBe(false);
  });

  test("does not mutate the shared template", () => {
    const manifest = sourceManifest();
    const before = JSON.stringify(manifest);

    projectExtensionManifest(manifest, "chromium", { version: "1.2.3.4" });
    projectExtensionManifest(manifest, "firefox", {
      firefoxUpdateUrl: "https://example.com/updates.json",
      version: "1.2.3.4",
    });

    expect(JSON.stringify(manifest)).toBe(before);
  });

  test("rejects nonportable versions and unsafe update URLs", () => {
    for (const version of ["01.2", "1.2.3.4.5", "1.65536", "v1"]) {
      expect(() =>
        projectExtensionManifest(sourceManifest(), "chromium", { version }),
      ).toThrow("Invalid extension version");
    }
    for (const firefoxUpdateUrl of [
      "http://example.com/updates.json",
      "https://user@example.com/updates.json",
      "https://example.com/updates.json#release",
      "not-a-url",
    ]) {
      expect(() =>
        projectExtensionManifest(sourceManifest(), "firefox", {
          firefoxUpdateUrl,
        }),
      ).toThrow("Invalid update URL");
      expect(() =>
        projectExtensionManifest(sourceManifest(), "chromium", {
          chromiumUpdateUrl: firefoxUpdateUrl,
        }),
      ).toThrow("Invalid update URL");
    }
  });

  // A file the manifest or a page names but the source lacks would ship a
  // broken package; the build would fail only at copy time.
  test("every packaged file has a source", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const files = await packagedFiles(sourceManifest());

    expect(files.entrypoints).toContain(
      path.join(root, "src/extension/popup.ts"),
    );
    for (const entrypoint of files.entrypoints)
      expect(existsSync(entrypoint)).toBe(true);
    for (const icon of files.icons)
      expect(existsSync(path.join(root, "src/spa/assets", icon))).toBe(true);
    for (const file of files.staticFiles)
      expect(existsSync(path.join(root, "src/extension", file))).toBe(true);
  });
});
