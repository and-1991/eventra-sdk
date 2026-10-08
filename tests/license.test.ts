import { readFileSync } from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const pkgDir = path.resolve(__dirname, "..");

const license = readFileSync(path.join(pkgDir, "LICENSE"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
  license: string;
  author?: { name?: string; url?: string };
};

describe("LICENSE (published to npm and mirrored to GitHub)", () => {
  it("is the complete MIT text: grant, conditions, notice requirement and warranty disclaimer", () => {
    expect(license.startsWith("MIT License\n\nCopyright (c) ")).toBe(true);
    expect(license).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(license).toContain("furnished to do so, subject to the following conditions:");
    expect(license).toContain("The above copyright notice and this permission notice shall be included in all");
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(license.trimEnd().endsWith("OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.")).toBe(true);
  });

  it("names a copyright year and holder, and the holder is the package author", () => {
    const holder = /^Copyright \(c\) \d{4} (\S.*)$/m.exec(license)?.[1];
    expect(holder).toBeTruthy();
    expect(pkg.author?.name).toBe(holder);
  });

  it("matches the license and author declared in package.json", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.author?.url).toMatch(/^https:\/\/github\.com\/[\w-]+$/);
  });
});
