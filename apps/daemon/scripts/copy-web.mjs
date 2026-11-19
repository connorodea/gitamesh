import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/web/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(
  ["queue.html", "queue.css", "queue.js"].map((file) =>
    copyFile(new URL(`../src/web/${file}`, import.meta.url), new URL(file, destination)),
  ),
);
