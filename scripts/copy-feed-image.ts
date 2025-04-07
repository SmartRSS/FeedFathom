import { copyFile } from "node:fs/promises";
import { join } from "node:path";

async function copyFeedImage() {
  const sourcePath = join(process.cwd(), "src", "lib", "images", "feed.png");
  const targetPath = join(process.cwd(), "static", "images", "feed.png");

  try {
    await copyFile(sourcePath, targetPath);
    console.log("Successfully copied feed image to static directory");
  } catch (error) {
    console.error("Failed to copy feed image:", error);
    process.exit(1);
  }
}

void copyFeedImage();
