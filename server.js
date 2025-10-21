import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, version: "1.0.0" }));

app.post("/validate", async (req, res) => {
  const started = Date.now();
  const files = req.body?.files || {};
  if (!files["main.tf"]) return res.status(400).json({ error: "files.main.tf required" });

  const work = path.join("/tmp", "run-" + randomUUID());
  await fs.mkdir(work, { recursive: true });

  try {
    // Write files into a clean workdir
    await Promise.all(
      Object.entries(files).map(([n, c]) => fs.writeFile(path.join(work, n), c))
    );

    // Ensure providers.tf exists (ok to overwrite if user sent one)
    if (!files["providers.tf"]) {
      await fs.writeFile(path.join(work, "providers.tf"),
`terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
provider "aws" { region = "us-east-1" }`);
    }

    const logs = [];
    const run = (cmd, args) => new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: work, env: process.env });
      let out = "", err = "";
      p.stdout.on("data", d => { const s=d.toString(); logs.push(s); });
      p.stderr.on("data", d => { const s=d.toString(); logs.push(s); err += s; });
      p.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    });

    // Fast path: no backend, cached provider, no input prompts
    await run("terraform", ["init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color"]);
    const validateJson = await new Promise((resolve, reject) => {
      const p = spawn("terraform", ["validate", "-json", "-no-color"], { cwd: work, env: process.env });
      let out = "", err = "";
      p.stdout.on("data", d => { const s=d.toString(); logs.push(s); out += s; });
      p.stderr.on("data", d => { const s=d.toString(); logs.push(s); err += s; });
      p.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || out)));
    });

    let parsed = {};
    try { parsed = JSON.parse(validateJson); } catch {}
    const durationMs = Date.now() - started;
    const status = parsed.valid ? "passed" : "failed";
    res.json({ status, exitCode: parsed.valid ? 0 : 1, durationMs, logs, diagnostics: parsed.diagnostics || [] });
  } catch (e) {
    const durationMs = Date.now() - started;
    res.status(200).json({ status: "failed", exitCode: 1, durationMs, error: String(e), logs: [] });
  } finally {
    // Best-effort cleanup
    //test
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("fast-tf-runner listening on", port));
