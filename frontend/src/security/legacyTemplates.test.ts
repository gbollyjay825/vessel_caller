import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("legacy printed reports escape query strings before inserting markup", async () => {
  const html = readFileSync(resolve("../calabar/pdf.html"), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
  const nodes: Record<string, { innerHTML: string; textContent: string }> = {};
  const payload = '<img src=x onerror="window.injected=true">';
  runInNewContext(script, {
    URLSearchParams,
    location: { search: new URLSearchParams({ vessel: payload, port: payload, invoiceNo: payload, doc: "invoice" }).toString() },
    document: { title: "", getElementById: (id: string) => nodes[id] ??= { innerHTML: "", textContent: "" } },
    fetch: async () => ({ ok: false }),
    localStorage: { getItem: () => null },
  });
  expect(nodes.page.innerHTML).not.toContain(payload);
  expect(nodes.page.innerHTML).toContain("&lt;img src=x onerror=&quot;window.injected=true&quot;&gt;");
});
