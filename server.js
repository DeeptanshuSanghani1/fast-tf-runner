// server.js
// Cloud Run Terraform runner that executes EXACTLY the requested command.
// Supports: fmt, validate, plan. Returns structured outputs.
// Optional auth via RUNNER_TOKEN=... (Bearer token check).

import express from "express";
import { promises as fsp } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const app = express();

// ---- Config -----------------------------------------------------------------
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || ""; // set to require Bearer token
const JSON_LIMIT_MB = 25;

// -----------------------------------------------------------------------------
app.use(express.json({ limit: `${JSON_LIMIT_MB}mb` }));

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// ---- Helpers ----------------------------------------------------------------
function unauthorized(res, msg) {
  return res.status(401).json({ ok: false, error: msg || "unauthorized" });
}

function forbidden(res, msg) {
  return res.status(403).json({ ok: false, error: msg || "forbidden" });
}

// Wrap execFile with a larger buffer (plan JSON can be large)
async function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...opts });
}

async function writeFiles(rootDir, files) {
  // Accept either: { "main.tf": "..." } OR [{ path, content }, ...]
  if (Array.isArray(files)) {
    for (const f of files) {
      const p = join(rootDir, f.path);
      await fsp.mkdir(dirname(p), { recursive: true });
      await fsp.writeFile(p, f.content ?? "", "utf8");
    }
    return;
  }
  for (const [name, content] of Object.entries(files || {})) {
    const p = join(rootDir, name);
    await fsp.mkdir(dirname(p), { recursive: true });
    await fsp.writeFile(p, content ?? "", "utf8");
  }
}

function hasAnyTf(files) {
  if (Array.isArray(files)) {
    return files.some((f) => f.path && f.path.endsWith(".tf"));
  }
  return Object.keys(files || {}).some((k) => k.endsWith(".tf"));
}

// ---- Core executor -----------------------------------------------------------
async function executeTerraform({ command, files, userEnv = {}, region }) {
  const started = Date.now();
  const workdir = await mkdtemp(join(tmpdir(), "tf-"));

  const baseEnv = {
    ...process.env,
    ...userEnv,               // e.g., AWS_* or other provider env (pasted or OIDC)
    TF_IN_AUTOMATION: "1",
  };
  if (!baseEnv.AWS_REGION && region) baseEnv.AWS_REGION = region;

  const result = {
    ok: false,
    command,
    hasInit: false,
    hasValidate: false,
    hasPlan: false,
    fmt: null,
    init: null,
    validate: null,
    plan: null,     // human-readable plan text
    planJson: null, // JSON plan string
    logs: [],
    durationMs: 0,
  };

  function log(s) {
    result.logs.push(s);
  }

  const tf = async (...args) => {
    log(`$ terraform ${args.join(" ")}`);
    return run("terraform", args, { cwd: workdir, env: baseEnv });
  };

  try {
    await writeFiles(workdir, files);

    if (!hasAnyTf(files)) {
      result.durationMs = Date.now() - started;
      return { status: 400, body: { ok: false, error: "no .tf files provided" }, cleanupDir: workdir };
    }

    // ----- FMT (no init) -----------------------------------------------------
    if (command === "fmt") {
      try {
        const fmt = await tf("fmt", "-check", "-no-color");
        result.fmt = (fmt.stdout || "") + (fmt.stderr || "");
        result.ok = true;
        result.durationMs = Date.now() - started;
        return { status: 200, body: result, cleanupDir: workdir };
      } catch (e) {
        // fmt -check returns non-zero if reformat needed
        result.fmt = `${e.stdout || ""}${e.stderr || ""}`.trim();
        result.ok = false;
        result.durationMs = Date.now() - started;
        return { status: 400, body: result, cleanupDir: workdir };
      }
    }

    // ----- INIT --------------------------------------------------------------
    // validate: offline init (backend=false) to avoid remote access
    // plan: full init (backend enabled) so state/backend & data sources can be accessed
    const initArgs =
      command === "validate"
        ? ["init", "-backend=false", "-input=false", "-no-color"]
        : ["init", "-input=false", "-no-color"];

    try {
      const init = await tf(...initArgs);
      result.init = (init.stdout || "") + (init.stderr || "");
      result.hasInit = true;
    } catch (e) {
      result.init = `${e.stdout || ""}${e.stderr || ""}`.trim();
      result.hasInit = false;
      result.durationMs = Date.now() - started;
      return { status: 400, body: result, cleanupDir: workdir };
    }

    // ----- VALIDATE ----------------------------------------------------------
    if (command === "validate") {
      try {
        const v = await tf("validate", "-no-color");
        result.validate = (v.stdout || "") + (v.stderr || "");
        result.hasValidate = true;
        result.ok = true;
        result.durationMs = Date.now() - started;
        return { status: 200, body: result, cleanupDir: workdir };
      } catch (e) {
        result.validate = `${e.stdout || ""}${e.stderr || ""}`.trim();
        result.hasValidate = false;
        result.ok = false;
        result.durationMs = Date.now() - started;
        return { status: 400, body: result, cleanupDir: workdir };
      }
    }

    // ----- PLAN --------------------------------------------------------------
    if (command === "plan") {
      try {
        await tf("plan", "-no-color", "-out=plan.bin");
      } catch (e) {
        // Plan failed (often missing creds/backends). Return the output.
        result.plan = `${e.stdout || ""}${e.stderr || ""}`.trim();
        result.durationMs = Date.now() - started;
        return { status: 400, body: result, cleanupDir: workdir };
      }

      // Human-readable text
      const showText = await tf("show", "-no-color", "plan.bin");
      result.plan = (showText.stdout || "") + (showText.stderr || "");

      // JSON (best-effort)
      try {
        const showJson = await tf("show", "-json", "plan.bin");
        result.planJson = showJson.stdout || null;
      } catch {
        result.planJson = null;
      }

      result.hasPlan = true;
      result.ok = true;
      result.durationMs = Date.now() - started;
      return { status: 200, body: result, cleanupDir: workdir };
    }

    // Unsupported
    result.durationMs = Date.now() - started;
    return { status: 400, body: { ok: false, error: `unsupported command: ${command}` }, cleanupDir: workdir };
  } catch (err) {
    const msg =
      (err && typeof err === "object" && "stderr" in err)
        ? `${err.stdout || ""}${err.stderr || ""}`.trim()
        : (err?.message || String(err));
    return { status: 500, body: { ok: false, error: msg }, cleanupDir: workdir };
  }
}

// ---- Routes ------------------------------------------------------------------

// New, command-aware endpoint:
// Body: { command: "fmt"|"validate"|"plan", files: {...} or [{path,content}], env?: {...}, region?: "us-east-1" }
app.post("/run", async (req, res) => {
  // Optional bearer token gate
  if (RUNNER_TOKEN) {
    const auth = req.get("authorization") || "";
    if (!auth.startsWith("Bearer ")) return unauthorized(res, "missing bearer token");
    const token = auth.slice("Bearer ".length);
    if (token !== RUNNER_TOKEN) return forbidden(res, "bad token");
  }

  const command = String(req.body?.command || "validate").toLowerCase();
  const files = req.body?.files || {};
  const region = req.body?.region || process.env.AWS_REGION || "us-east-1";
  const userEnv = req.body?.env || {};

  const { status, body, cleanupDir } = await executeTerraform({ command, files, userEnv, region });
  try { await rm(cleanupDir, { recursive: true, force: true }); } catch {}
  return res.status(status).json(body);
});

// Backward compatibility: /validate => runs validate pipeline
// Body: { files: {...} } (legacy)
app.post("/validate", async (req, res) => {
  if (RUNNER_TOKEN) {
    const auth = req.get("authorization") || "";
    if (!auth.startsWith("Bearer ")) return unauthorized(res, "missing bearer token");
    const token = auth.slice("Bearer ".length);
    if (token !== RUNNER_TOKEN) return forbidden(res, "bad token");
  }

  const files = req.body?.files || {};
  const region = req.body?.region || process.env.AWS_REGION || "us-east-1";
  const userEnv = req.body?.env || {};

  const { status, body, cleanupDir } = await executeTerraform({ command: "validate", files, userEnv, region });
  try { await rm(cleanupDir, { recursive: true, force: true }); } catch {}
  return res.status(status).json(body);
});

// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`runner listening on :${PORT}`);
});
