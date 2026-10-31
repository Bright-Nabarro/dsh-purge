// Web/CLI 面的三处误判回归：
// 1) 默认关闭的 opt-in 补丁（#18/#19）被 summarizeApplyReport 计成失败；
// 2) 拼装布局没有 dsh-agent-loop / dsh-system-prompt，版本读成 unknown；
// 3) 没有官方桌面 exe 时 CLI 修复被报成 not_official。
// 桌面面行为必须一分不动。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compatibility, QUALIFIED_HOST_VERSIONS } from "../lib/community.js";
import {
  ALL_PATCHES,
  summarizeApplyReport,
  webSurfaceWriteEvidence,
  repairOfficialCliAfterUnpack,
} from "../lib/core.js";

function webFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-websurface-"));
  const host = path.join(root, "node_modules/@deepseek-ai");
  fs.mkdirSync(path.join(host, "dsh-base"), { recursive: true });
  fs.writeFileSync(
    path.join(host, "dsh-base/package.json"),
    JSON.stringify({ name: "dsh-base", version: "0.2.1-rc.5" }),
  );
  fs.mkdirSync(path.join(host, "dsh-agent-instructions/lib"), { recursive: true });
  return { root, host, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function withSurface(surface, run) {
  const saved = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = surface;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = saved;
  }
}

test("web layout reads its version from dsh-base instead of the desktop components", () => {
  const f = webFixture();
  try {
    assert(QUALIFIED_HOST_VERSIONS.includes("0.2.1-rc.5"));
    const c = withSurface("web", () => compatibility(f.host));
    assert.equal(c.host_version, "0.2.1-rc.5");
    assert.equal(c.prompt_version, "0.2.1-rc.5");
    assert.equal(c.version_source, "dsh-base");
    assert.equal(c.runtime_supported, true);
    assert.equal(c.qualified, true);
    assert.equal(c.level, "qualified");
    assert.equal(c.patch_writes_allowed, true);
  } finally {
    f.close();
  }
});

test("desktop surface still requires the two official components", () => {
  const f = webFixture();
  try {
    const c = withSurface("desktop", () => compatibility(f.host));
    assert.equal(c.host_version, "unknown");
    assert.equal(c.prompt_version, "unknown");
    assert.equal(c.version_source, "none");
    assert.equal(c.runtime_supported, false);
    assert.equal(c.qualified, false);
    assert.equal(c.level, "unverified");
  } finally {
    f.close();
  }
});

test("disabled opt-in patches are not counted as apply failures", () => {
  const patch18 = ALL_PATCHES.find((p) => p.id === 18);
  const patch19 = ALL_PATCHES.find((p) => p.id === 19);
  assert.equal(patch18.disabledByDefault, true);
  assert.equal(patch19.disabledByDefault, true);
  const report = [
    { patch_id: 18, name: patch18.name, status: "disabled" },
    { patch_id: 19, name: patch19.name, status: "disabled" },
    { patch_id: 1, name: "already-there", status: "already" },
  ];
  const summary = summarizeApplyReport(report);
  assert.equal(summary.failed.length, 0, "an intentional off switch is not a failure");
  assert.equal(summary.soft.length, 3);
  assert.equal(summary.already, 1);
});

test("real failures are still failures after the disabled change", () => {
  const summary = summarizeApplyReport([
    { patch_id: 1, name: "drifted", status: "pattern_not_found" },
    { patch_id: 2, name: "read error", status: "read_error" },
  ]);
  assert.equal(summary.failed.length, 2);
});

test("web surface treats a clean apply report as host write evidence", () => {
  const clean = [{ patch_id: 1, name: "a", status: "already" }];
  assert.equal(webSurfaceWriteEvidence(clean, summarizeApplyReport(clean)), true);
  const applied = [{ patch_id: 1, name: "a", status: "applied" }];
  assert.equal(webSurfaceWriteEvidence(applied, summarizeApplyReport(applied)), true);
  const broken = [{ patch_id: 1, name: "a", status: "pattern_not_found" }];
  assert.equal(webSurfaceWriteEvidence(broken, summarizeApplyReport(broken)), false);
  assert.equal(webSurfaceWriteEvidence([], summarizeApplyReport([])), false);
  assert.equal(webSurfaceWriteEvidence(clean, null), false);
});

test("CLI repair on the web surface is a no-op, not not_official", () => {
  const result = withSurface("web", () => repairOfficialCliAfterUnpack());
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "web_surface");
});
