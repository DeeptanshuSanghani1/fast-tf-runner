// server.js
import express from "express";
import { promises as fs } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

// POST /validate { files: {"main.tf": "...", "variables.tf": "...", "providers.tf": "..." } }
app.post("/validate", async (req, res) => {
  const start = Date.now();
  const files = req.body?.files || {};
  if (!files["main.tf"]) {
    return res.status(400).json({ ok: false, error: "main.tf missing" });
  }

  const workdir = await mkdtemp(join(tmpdir(), "tf-"));
  try {
    // write files
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        fs.writeFile(join(workdir, name), content)
      )
    );

    const initArgs = [
      "-chdir=" + workdir,
      "init",
      "-backend=false",
      "-input=false",
      "-no-color",
    ];
    // use local mirror to avoid network/provider fetch
    const env = { ...process.env, TF_CLI_ARGS_init: '-plugin-dir=/mirror' };

    const { stdout: initOut, stderr: initErr } = await execFileAsync("terraform", initArgs, { env });
    const { stdout: valOut, stderr: valErr } = await execFileAsync("terraform", ["-chdir=" + workdir, "validate", "-no-color"], { env });

    const ms = Date.now() - start;
    res.json({
      ok: true,
      init: initOut + initErr,
      validate: valOut + valErr,
      durationMs: ms,
    });
  } catch (e) {
    res.status(200).json({
      ok: false,
      error: e?.message || String(e),
    });
  } finally {
    // clean temp dir
    try { await rm(workdir, { recursive: true, force: true }); } catch {}
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`runner listening on :${PORT}`);
});
