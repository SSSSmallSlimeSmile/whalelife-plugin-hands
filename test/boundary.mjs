/**
 * 读文件的边界与报错形态：不过宿主，直接加载插件本体。
 * 用法：node test/boundary.mjs （在插件目录下跑）
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { apply } from "../index.ts";

const ROOT = process.cwd();
const TMP = resolve(ROOT, ".tmp", "boundary");
await mkdir(TMP, { recursive: true });

const defs = [];
const ctx = {
  config: { read: async () => null },
  tools: { register: (d) => defs.push(d), registerTransient: (d) => defs.push(d) },
  effect: (fn) => { fn(); return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};
await apply(ctx);

const raw = async (n, a) => await defs.find((d) => d.name === n).run(a ?? {}, {});
const call = async (n, a) => {
  const o = await raw(n, a);
  return o && typeof o === "object" && "content" in o ? String(o.content) : String(o);
};

const cases = [];
const check = (l, ok, d) => cases.push({ l, ok, d });

await writeFile(resolve(TMP, "three.txt"), "a\nb\nc", "utf8");
await writeFile(resolve(TMP, "empty.txt"), "", "utf8");
const p3 = resolve(TMP, "three.txt");
const pe = resolve(TMP, "empty.txt");

const r1 = await call("hands_read", { path: p3 });
check("正常读：头写区间与总数", r1.includes("第 1–3 行，共 3 行"), r1.split("\n")[0]);
const r9 = await call("hands_read", { path: p3, offset: 1 });
check("从中间读：头写 2–3", r9.includes("第 2–3 行，共 3 行"), r9.split("\n")[0]);
const r2 = await call("hands_read", { path: p3, offset: 9 });
check("offset 越界报错", r2.startsWith("错误：") && r2.includes("超出范围") && r2.includes("只有 3 行"), r2.slice(0, 80));
const r3 = await call("hands_read", { path: p3, offset: 3 });
check("offset==total 不报错且说明已读完", !r3.startsWith("错误：") && r3.includes("已经在末尾"), r3.slice(0, 80));
const r4 = await call("hands_read", { path: pe });
check("空文件单独说明", r4.includes("空文件，0 字节"), r4);
const r5 = await call("hands_read", { path: resolve(TMP, "nope.txt") });
check("不存在与空分开", r5.includes("文件不存在"), r5.slice(0, 60));
const r6 = await call("hands_read", { path: p3, offset: -1 });
check("负数 offset 拒绝", r6.includes("非负整数"), r6.slice(0, 60));
const r7 = await call("hands_read", { path: p3, offset: 1.5 });
check("小数 offset 拒绝", r7.includes("非负整数"), r7.slice(0, 60));
const r8 = await call("hands_read", { path: p3, limit: 0 });
check("limit 0 拒绝", r8.includes("1 的整数"), r8.slice(0, 60));
const l1 = await call("hands_list", { path: TMP, depth: 10 });
check("depth 超限标注", l1.includes("depth 上限 3"), l1.trim().split("\n").slice(-1)[0]);
const l2 = await call("hands_list", { path: TMP, depth: 0 });
check("depth 0 拒绝", l2.includes("1 的整数"), l2.slice(0, 60));

let pass = 0;
for (const c of cases) {
  console.log((c.ok ? "PASS " : "FAIL ") + c.l + "  -  " + c.d);
  if (c.ok) pass++;
}
console.log(pass + "/" + cases.length + " 通过");
await rm(TMP, { recursive: true, force: true });
if (pass !== cases.length) process.exitCode = 1;