/**
 * 冒烟测试：不经过宿主，直接加载插件并逐个调工具。
 * 用法：node test/smoke.mjs   （在插件目录下跑；需要 Node 24）
 *
 * 不依赖插件装在宿主里的位置：允许根目录就是当前工作目录（本仓库根），
 * 写测试的临时文件落在 .tmp/ 下，跑完删掉；备份落在 data/backups/（已在 .gitignore）。
 *
 * 这里模拟宿主同时提供 register 和 registerTransient：hands_run 走临时输出，
 * 正文只当轮，回执是有界 JSON。其余工具仍走普通 register。
 */
import { mkdir, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { apply } from "../index.ts";

const ROOT = process.cwd();
const TMP = resolve(ROOT, ".tmp");
await mkdir(TMP, { recursive: true });

const defs = [];
const disposers = [];
const ctx = {
  config: { read: async () => null },          // 走默认配置：roots 回落到 cwd
  tools: {
    register: (def) => defs.push(def),
    registerTransient: (def) => defs.push(def), // 宿主给了也不会改变返回值形状
  },
  effect: (fn) => { disposers.push(fn()); return () => {}; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

await apply(ctx);
console.log(`注册工具: ${defs.map((d) => `${d.name}(${d.danger})`).join(", ")}`);

const find = (name) => {
  const d = defs.find((x) => x.name === name);
  if (!d) throw new Error(`工具未注册：${name}`);
  return d;
};
const raw = async (name, args) => await find(name).run(args ?? {}, {});
const call = async (name, args) => {
  const out = await raw(name, args);
  if (out && typeof out === "object" && "content" in out) return String(out.content);
  return String(out);
};

const cases = [];
const check = (label, ok, detail) => cases.push({ label, ok, detail });

// 1 列目录
const list = await call("hands_list", { path: "." });
check("hands_list 列到本仓库文件", list.includes("plugin.yaml"), list.split("\n")[0]);

// 2 读文件
const read = await call("hands_read", { path: "plugin.yaml", limit: 5 });
check("hands_read 读到内容", read.includes("id: hands"), read.split("\n")[1] ?? "");

// 3 越界拒绝（相对路径往上跳）
const deny = await call("hands_read", { path: "../outside.txt" });
check("越界被拒", deny.startsWith("错误：读文件被拒绝"), deny.slice(0, 60));

// 4 $ 不被吞
const run = await call("hands_run", { command: '$v = 41 + 1; Write-Output "n=$v"' });
check("hands_run 变量没被外层展开", run.includes("n=42"), run.split("\n").find((l) => l.includes("n=")) ?? run.slice(0, 60));

// 5 中文输出
const cn = await call("hands_run", { command: 'Write-Output "中文测试"' });
check("中文输出不乱码", cn.includes("中文测试"), cn.split("\n").find((l) => l.includes("中文")) ?? cn.slice(0, 60));

// 6 退出码
const bad = await call("hands_run", { command: "Get-Item 'Z:\\不存在的目录\\文件.txt'" });
check("失败命令有非零码", /退出码 1/.test(bad), bad.split("\n")[0]);

// 7 禁止项
const banned = await call("hands_run", { command: "format C:" });
check("禁止项被拦", banned.includes("命中禁止项"), banned.slice(0, 60));

// 8 写 + 核验
const target = ".tmp/smoke-hands.txt";
const write = await call("hands_write", { path: target, content: "第一行\n第二行\n" });
const verify = await call("hands_run", {
  command: "Write-Output 'noop'",
  verify_files: [{ path: target, contains: ["第二行"], absent: ["不该出现"] }],
});
check("hands_write 写入", write.includes("已写入"), write.slice(0, 60));
check(
  "verify_files 通过",
  /已验证变化 0，已满足无变化 1，验证失败 0/.test(verify) && !verify.includes("文件核验未通过"),
  verify.split("\n")[1] ?? verify.split("\n")[0],
);

// 9 临时输出：正文只当轮，回执是有界 JSON，且不抄正文
const plain = await raw("hands_run", { command: "Write-Output ('临时' + '正文')" });
const receiptText = JSON.stringify(plain?.receipt ?? null);
check(
  "hands_run 正文当轮、回执极简",
  !!plain && typeof plain === "object"
    && String(plain.content).includes("临时正文")
    && String(plain.content).startsWith("退出码 0")
    && plain.receipt?.exit_code === 0
    && plain.receipt?.tool === "hands_run"
    && !receiptText.includes("临时正文"),
  receiptText.slice(0, 120),
);

// 10 覆盖前留副本
const backupTarget = ".tmp/smoke-backup.txt";
await call("hands_write", { path: backupTarget, content: "第一版\n" });
const overwrite = await call("hands_write", { path: backupTarget, content: "第二版\n" });
let backupCount = 0;
try {
  backupCount = (await readdir(resolve(ROOT, "data", "backups"))).filter((n) => n.includes("smoke-backup")).length;
} catch { backupCount = 0; }
check(
  "覆盖前留副本",
  overwrite.includes("原文件已备份") && backupCount > 0,
  `${overwrite.split("\n")[1] ?? overwrite.split("\n")[0]} / 目录中 ${backupCount} 份`,
);

// 11 版本比对：哈希不符拒写，文件内容不变
const beforeSha = await call("hands_run", {
  command: `(Get-FileHash -Algorithm SHA256 -LiteralPath '${backupTarget.replace(/\\/g, "\\\\")}').Hash`,
});
const wrong = await call("hands_write", {
  path: backupTarget, content: "第三版\n", expected_sha256: "0".repeat(64),
});
const afterRead = await call("hands_read", { path: backupTarget });
check(
  "expected_sha256 不符时拒写",
  wrong.startsWith("错误：版本比对失败") && afterRead.includes("第二版") && !afterRead.includes("第三版"),
  wrong.slice(0, 80),
);

// 12 版本比对：哈希对得上就放行
const realSha = (beforeSha.match(/[0-9A-Fa-f]{64}/) ?? [""])[0].toLowerCase();
const right = await call("hands_write", {
  path: backupTarget, content: "第三版\n", expected_sha256: realSha,
});
const finalRead = await call("hands_read", { path: backupTarget });
check(
  "expected_sha256 相符时写入",
  realSha.length === 64 && right.includes("已写入") && finalRead.includes("第三版"),
  right.split("\n")[0],
);

await rm(TMP, { recursive: true, force: true });

let pass = 0;
for (const c of cases) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}  —  ${String(c.detail).trim()}`);
  if (c.ok) pass++;
}
console.log(`\n${pass}/${cases.length} 通过`);

// 清理钩子可能已随进程结束；显式退出码由用例结果决定。
process.exit(pass === cases.length ? 0 : 1);
