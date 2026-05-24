import {DiagnosticCodes} from "./codes.js";
import {DOC_URLS, releasesUrl} from "./doc-urls.js";

describe("DOC_URLS", () => {
  it("has a URL for every DiagnosticCode", () => {
    for (const code of Object.values(DiagnosticCodes)) {
      expect(DOC_URLS[code]).toMatch(/^https:\/\//);
    }
  });
});

describe("releasesUrl", () => {
  it("links to /releases/tag/<ref> for a tag-like ref", () => {
    expect(releasesUrl("actions", "checkout", "v4")).toBe("https://github.com/actions/checkout/releases/tag/v4");
  });

  it("links to /releases when ref is omitted", () => {
    expect(releasesUrl("actions", "checkout")).toBe("https://github.com/actions/checkout/releases");
  });

  it("falls back to /releases for a branch-like ref", () => {
    expect(releasesUrl("actions", "checkout", "main")).toBe("https://github.com/actions/checkout/releases");
  });

  it("falls back to /releases for a full SHA", () => {
    const sha = "8e8c483db84b4bee98b60c0593521ed34d9990e8";
    expect(releasesUrl("actions", "checkout", sha)).toBe("https://github.com/actions/checkout/releases");
  });
});
