import { describe, expect, test } from "bun:test";
import { projectExtensionManifest } from "../bin/generate-packages.ts";
import manifestTemplate from "../src/extension/manifest.json";

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
    expect(chromium.permissions).toEqual(["contextMenus", "storage"]);
    expect(chromium.version).toBe("2026.723.12.1");
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
      data_collection_permissions: { required: ["none"] },
      id: "feedfathom@smartrss",
      strict_min_version: "140.0",
      update_url: "https://example.com/assets/updates.json",
    });
    expect(firefox.version).toBe("2026.723.12.1");
  });

  test("omits Firefox update metadata from local builds", () => {
    const manifest = sourceManifest();
    const firefox = projectExtensionManifest(
      {
        ...manifest,
        browser_specific_settings: {
          ...manifest.browser_specific_settings,
          gecko: {
            ...manifest.browser_specific_settings.gecko,
            update_url: "%UPDATE_URL%",
          },
        },
      },
      "firefox",
    );
    if (!("browser_specific_settings" in firefox)) {
      throw new Error("Firefox settings missing");
    }

    expect("update_url" in firefox.browser_specific_settings.gecko).toBe(false);
    expect(JSON.stringify(firefox)).not.toContain("%UPDATE_URL%");
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
      ).toThrow("Invalid Firefox update URL");
    }
  });
});
