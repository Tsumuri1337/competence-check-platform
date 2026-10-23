// Рендер всех diagrams/*.mmd в PNG (2x) единым стилем: белый фон, Liberation Sans, чёрно-серые линии.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "diagrams");
const only = process.argv[2];
(async () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mmd") && (!only || f.startsWith(only)));
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await b.newPage({ deviceScaleFactor: 2.5, viewport: { width: 1800, height: 1200 } });
  await page.setContent(`<html><head><style>body{margin:0;background:#fff;font-family:'Liberation Sans',Arial,sans-serif}#out{display:inline-block;padding:12px}</style></head><body><div id="out"></div></body></html>`);
  await page.addScriptTag({ path: path.join(__dirname, "node_modules/mermaid/dist/mermaid.min.js") });
  await page.evaluate((env) => {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      securityLevel: "loose",
      fontFamily: "Liberation Sans, Arial, sans-serif",
      themeVariables: {
        fontFamily: "Liberation Sans, Arial, sans-serif", fontSize: env.FS || "15px",
        primaryColor: "#ffffff", primaryBorderColor: "#1b2430", primaryTextColor: "#1b2430",
        lineColor: "#1b2430", secondaryColor: "#f3f1ec", tertiaryColor: "#faf9f6",
        clusterBkg: "#faf9f6", clusterBorder: "#9a9384", edgeLabelBackground: "#ffffff",
        actorBkg: "#ffffff", actorBorder: "#1b2430", signalColor: "#1b2430", noteBkgColor: "#f6ecda", noteBorderColor: "#b8863d",
        labelBoxBkgColor: "#f3f1ec", activationBkgColor: "#eef1f4",
      },
      flowchart: { useMaxWidth: false, htmlLabels: true, curve: "linear", nodeSpacing: +(env.NS||34), rankSpacing: +(env.RS||40), padding: 8, wrappingWidth: 230 },
      sequence: { mirrorActors: false, messageMargin: 32, noteMargin: 8, boxMargin: 8, useMaxWidth: false, wrap: true, width: 170 },
      er: { useMaxWidth: false, layoutDirection: "TB" },
      state: { useMaxWidth: false },
    });
  }, { FS: process.env.FS, NS: process.env.NS, RS: process.env.RS });
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    try {
      const svg = await page.evaluate(async ({ src, id }) => {
        const { svg } = await window.mermaid.render(id, src);
        document.getElementById("out").innerHTML = svg;
        const el = document.querySelector("#out svg");
        el.style.maxWidth = "none";
        return true;
      }, { src, id: "d" + f.replace(/\W/g, "") });
      const el = await page.$("#out");
      await el.screenshot({ path: path.join(dir, f.replace(".mmd", ".png")) });
      const box = await el.boundingBox();
      console.log("ok ", f, Math.round(box.width), "x", Math.round(box.height));
    } catch (e) {
      console.log("ERR", f, e.message.split("\n").slice(0, 3).join(" | "));
    }
  }
  await b.close();
})();
