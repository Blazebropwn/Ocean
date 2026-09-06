import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ASSET_REFERENCE = /(href|src)="(\/[^"?]+\.(?:css|js))(?:\?v=[^"]*)?"/g;

// Rewrite local stylesheet/script references so each carries a content hash of
// the referenced file. A changed asset invalidates its own cached URL, and the
// hash comes from the file itself, so it can never drift or be forgotten.
export function versionAssetReferences(html: string, publicRoot: string, hashes = new Map<string, string>()) {
  return html.replace(ASSET_REFERENCE, (_match, attribute: string, assetPath: string) => {
    let hash = hashes.get(assetPath);
    if (hash === undefined) {
      try {
        hash = createHash("sha256").update(readFileSync(join(publicRoot, assetPath))).digest("hex").slice(0, 10);
      } catch {
        hash = "";
      }
      hashes.set(assetPath, hash);
    }
    return hash ? `${attribute}="${assetPath}?v=${hash}"` : `${attribute}="${assetPath}"`;
  });
}

export type VersionedPage = { routes: string[]; html: string };

// Render every public HTML page once with content-hashed asset URLs.
export function buildVersionedPages(publicRoot: string): VersionedPage[] {
  const hashes = new Map<string, string>();
  const pages: VersionedPage[] = [];
  for (const entry of readdirSync(publicRoot)) {
    if (!entry.endsWith(".html")) continue;
    const html = versionAssetReferences(readFileSync(join(publicRoot, entry), "utf8"), publicRoot, hashes);
    pages.push({ routes: entry === "index.html" ? ["/", "/index.html"] : [`/${entry}`], html });
  }
  return pages;
}
