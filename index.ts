/*! WhaleLife「手」插件：跑命令、读写文件、列目录。
 * 只调用公开接口；所有异常在本插件内收口，绝不向宿主抛出——
 * 宿主的 worker 包装器把工具异常视为插件故障，会直接撤销全部工具入口。
 *
 * 一条借自上游 computer 插件的做法：
 *  hands_write 覆盖已有文件前先留副本（30 天 / 1 GiB 上限），并支持
 *     expected_sha256 做版本比对——对不上就拒写，不静默盖掉别人的改动。
 */
import type { Context } from "../../core/context.ts";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { resolve, dirname, isAbsolute, sep, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const DEFAULTS = {
  roots: [], // 留空表示未配置：回落到宿主自己的工作目录，不把作者机器路径写进包里
  timeout_ms: 60_000,
  max_output_chars: 20_000,
  backup_keep_days: 30,
  backup_max_bytes: 1024 * 1024 * 1024,
  encoding_prelude: false, // true 时给每条命令加上控制台 UTF-8 两行（README 第 10 条）
  transient_output: true, // 命令正文只当轮可见，长期记忆只留极简回执；关掉则整段输出永久入档
  deny_patterns: [
    "format ", "diskpart", "mkfs", "bcdedit", "reg delete",
    "shutdown", "restart-computer", "stop-computer",
    "takeown", "icacls", "cipher /w",
    "rm -rf /", "del /f /s /q c:\\",
  ],
};

type Config = typeof DEFAULTS;

function norm(p: string): string {
  return resolve(p).replace(/[\\/]+$/, "");
}

function inside(target: string, roots: string[]): string | null {
  if (roots.map((r) => String(r).trim()).some((r) => r === "*" || r === "\\" || r === "/")) {
    return norm(target);
  }
  const t = norm(target).toLowerCase();
  for (const root of roots) {
    const r = norm(root).toLowerCase();
    if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) {
      return norm(target);
    }
  }
  return null;
}

function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n\n…… 中间省略 ${text.length - head.length - tail.length} 字符 ……\n\n${tail}`;
}

function tryDecode(buf: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true } as any).decode(buf);
  } catch {
    return null;
  }
}

/**
 * 控制台默认输出 GBK 字节。不能简单地"UTF-8 优先"：
 * 「值」的 GBK 字节是 D6 B5，恰好是合法 UTF-8，会解成 U+05B5。
 * 所以先严格解 UTF-8，只有在结果落进 GBK 被误读时常见的区段
 * （西里尔／希伯来／阿拉伯）时，才回头试 GBK，并以解出中日韩汉字为准。
 */
function decodeOutput(buf: Buffer | undefined): string {
  if (!buf || !buf.length) return "";
  const utf8 = tryDecode(buf, "utf-8");
  if (utf8 === null) return tryDecode(buf, "gbk") ?? buf.toString("utf8");
  if (!/[\u0400-\u07FF\uFFFD]/.test(utf8)) return utf8;
  const gbk = tryDecode(buf, "gbk");
  if (gbk && !gbk.includes("\uFFFD") && /[\u4e00-\u9fff]/.test(gbk)) return gbk;
  return utf8;
}

/**
 * 把脚本落成临时 .ps1，用 -File 执行。
 *
 * 为什么不再用 -Command：execFile 传的是参数数组，但 PowerShell 收到 -Command 后
 * 还会再解析一层，双引号里的 $ 会先被展开，脚本拿到的已经是展开后的字面量。
 * 走 -File 就没有这一层——文件里的 $ 原样进入脚本。
 *
 * 临时文件必须带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的 .ps1 按当前 ANSI
 * 代码页解析，中文会变乱码。配置文件要无 BOM，这里正好相反。
 *
 * 插件自带的 bin 目录（里面有 tsc.cmd 这类入口）要在脚本里前置到 $env:PATH，
 * 而不是改 execFile 的 env——改 env 会让 Node 找不到 powershell.exe（ENOENT）。
 *
 * 输出仍走 decodeOutput：控制台代码页是 936，PowerShell 自身输出是 GBK 字节。
 */
async function runShell(command: string, cwd: string, timeout: number, signal?: AbortSignal, prelude = false) {
  const file = join(tmpdir(), `hands-${randomBytes(8).toString("hex")}.ps1`);
  const cleanup = () => { unlink(file).catch(() => {}); };
  try {
    const binDir = join(dirname(fileURLToPath(import.meta.url)), "bin").replace(/'/g, "''");
    // 末尾补一句退出码：脚本最后一条命令失败时给个非零，否则 -File 恒为 0。
    const body = "$env:PATH = '" + binDir + ";' + $env:PATH\n"
      + (prelude ? "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$OutputEncoding = [Text.Encoding]::UTF8\n" : "")
      // 读文件一律按 UTF-8：PowerShell 5.1 的 Get-Content 默认走 ANSI 代码页（936），
      // 读自己写的 UTF-8 文件会读出「鏆傛椂」这类字，长度还会漂。设成默认参数以后，
      // 命令原样不动、也不拦，显式写 -Encoding 的仍以显式为准。
      // 刻意不设 [Console]::OutputEncoding：那会连带改原生命令的解码，ipconfig 这类中文输出会坏。
      + "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'\n"
      + "$PSDefaultParameterValues['Import-Csv:Encoding'] = 'utf8'\n"
      + command + "\nif (-not $?) { exit 1 }\n";
    await writeFile(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(body, "utf8"),
    ]));
  } catch (error: any) {
    cleanup();
    return { code: 1, stdout: "", stderr: `写临时脚本失败：${String(error?.message ?? error)}` };
  }
  return await new Promise<{ code: number; stdout: string; stderr: string }>((ok) => {
    let child: any;
    try {
      child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" },
        (err, stdout, stderr) => {
          cleanup();
          const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
          ok({
            code,
            stdout: decodeOutput(stdout as unknown as Buffer),
            stderr: decodeOutput(stderr as unknown as Buffer) || String(err?.message ?? ""),
          });
        },
      );
    } catch (error: any) {
      cleanup();
      ok({ code: 1, stdout: "", stderr: `启动 PowerShell 失败：${String(error?.message ?? error)}` });
      return;
    }
    signal?.addEventListener("abort", () => { child.kill(); cleanup(); }, { once: true });
  });
}

/** 工具异常必须变成文本返回，抛出去会让宿主撤销整个插件。 */
const safe = <A, S>(fn: (args: A, session: S) => Promise<unknown> | unknown) =>
  async (args: A, session: S) => {
    try {
      return await fn(args, session);
    } catch (error: any) {
      return `错误：${error?.message ?? String(error)}`;
    }
  };

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = (await ctx.config.read("config.json")) as Partial<Config> | null;
  } catch {
    saved = null;
  }
  const cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };
  const configured = Array.isArray(cfg.roots) ? cfg.roots.map(String).filter(Boolean) : [];
  const roots = configured.length ? configured : [resolve(".")];

  const guard = (p: string, what: string) => {
    const abs = isAbsolute(p) ? p : resolve(roots[0] === "*" ? "." : roots[0], p);
    const okPath = inside(abs, roots);
    if (!okPath) throw new Error(`${what}被拒绝：${p} 不在允许根目录内（${roots.join(" / ")}）`);
    return okPath;
  };

  const base = roots[0] === "*" ? resolve(".") : roots[0];

  /**
   * 备份目录落在插件自己的 data/backups 下，跟 roots 无关——
   * 这样即使 roots 只剩一个子目录，副本也写得进去。
   * 位置用 import.meta.url 推，插件被装在哪都能用。
   */
  let backupDirCache: string | null = null;
  const backupDir = async () => {
    if (!backupDirCache) {
      const here = dirname(fileURLToPath(import.meta.url));
      backupDirCache = join(here, "data", "backups");
      await mkdir(backupDirCache, { recursive: true });
    }
    return backupDirCache;
  };

  /** 按上限清理：先按时间删过期的，再按最旧的删到总量达标。 */
  const pruneBackups = async (dir: string) => {
    const keepDays = Math.max(1, Number(cfg.backup_keep_days) || 30);
    const maxBytes = Math.max(1024 * 1024, Number(cfg.backup_max_bytes) || 1024 * 1024 * 1024);
    let items: { path: string; size: number; mtime: number }[] = [];
    try {
      const names = await readdir(dir);
      for (const name of names) {
        const full = join(dir, name);
        try {
          const info = await stat(full);
          if (info.isFile()) items.push({ path: full, size: info.size, mtime: info.mtimeMs });
        } catch { /* 单个文件读不到就跳过，别让清理影响主流程 */ }
      }
    } catch { return; }
    const now = Date.now();
    const expire = keepDays * 24 * 60 * 60 * 1000;
    const kept: typeof items = [];
    for (const item of items) {
      if (now - item.mtime > expire) {
        await unlink(item.path).catch(() => {});
      } else {
        kept.push(item);
      }
    }
    let total = kept.reduce((sum, item) => sum + item.size, 0);
    kept.sort((a, b) => a.mtime - b.mtime);
    for (const item of kept) {
      if (total <= maxBytes) break;
      await unlink(item.path).catch(() => {});
      total -= item.size;
    }
  };

  /** 覆盖前留一份原始字节。文件本来不存在就返回 null，不算失败。 */
  const backupFile = async (file: string): Promise<{ path: string; bytes: number; sha256: string } | null> => {
    let before: Buffer;
    try {
      before = await readFile(file);
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`备份原文件时读不到：${file}（${String(error?.code ?? error?.message ?? "未知")}）`);
    }
    const dir = await backupDir();
    const sha256 = createHash("sha256").update(before).digest("hex");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    const dest = join(dir, `${stamp}-${sha256.slice(0, 8)}-${basename(file)}`);
    await writeFile(dest, before);
    await pruneBackups(dir);
    return { path: dest, bytes: before.byteLength, sha256 };
  };

  /** 一次读回的快照：字节数、sha256、以及跑字面量断言用的文本都来自同一份 Buffer。 */
  type Snapshot = { exists: boolean; bytes: number | null; sha256: string | null; text: string };

  const snapshot = async (file: string): Promise<Snapshot> => {
    try {
      const buffer = await readFile(file);
      return { exists: true, bytes: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        text: buffer.toString("utf8") };
    } catch (error: any) {
      // 只有 ENOENT 才算「本来就不存在」；别的读错误必须报出来，不能当成空文件。
      if (error?.code === "ENOENT") return { exists: false, bytes: null, sha256: null, text: "" };
      throw new Error(`取基线失败：${file} 读取错误 ${String(error?.code ?? error?.message ?? "未知")}`);
    }
  };

  type Planned = { abs: string; label: string; contains: string[]; absent: string[] };

  /** verify_files 的形状校验与路径解析。任何一条不合规都在执行命令之前抛错。 */
  const planVerify = (raw: any, cwd: string): Planned[] => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error("verify_files 必须是数组");
    if (raw.length > 10) throw new Error(`verify_files 最多 10 个文件，收到 ${raw.length} 个`);
    const seen = new Set<string>();
    return raw.map((item: any, index: number) => {
      const at = `verify_files[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${at} 必须是对象`);
      const rawPath = String(item.path ?? "").trim();
      if (!rawPath) throw new Error(`${at}.path 不能为空`);
      const list = (value: any, field: string) => {
        if (value === undefined || value === null) return [] as string[];
        if (!Array.isArray(value)) throw new Error(`${at}.${field} 必须是字符串数组`);
        return value.map((entry: any, i: number) => {
          if (typeof entry !== "string") throw new Error(`${at}.${field}[${i}] 必须是字符串`);
          if (!entry.trim()) throw new Error(`${at}.${field}[${i}] 不能是空串`);
          return entry;
        });
      };
      const contains = list(item.contains, "contains");
      const absent = list(item.absent, "absent");
      if (!contains.length && !absent.length)
        throw new Error(`${at} 至少要有一条 contains 或 absent 断言，否则核验没有意义`);
      const abs = guard(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath), "核验文件");
      const key = abs.toLowerCase();
      if (seen.has(key)) throw new Error(`verify_files 里有重复路径：${rawPath}`);
      seen.add(key);
      return { abs, label: rawPath, contains, absent };
    });
  };

  const clip = (value: string) => (value.length > 60 ? `${value.slice(0, 60)}…` : value);

  type Verdict = { state: "changed" | "unchanged" | "failed"; line: string; detail?: string;
    after?: Snapshot };

  /** 跑完命令后的回读：先看断言，再看有没有真的变。 */
  const verifyFile = async (item: Planned, before: Snapshot): Promise<Verdict> => {
    let after: Snapshot;
    try {
      after = await snapshot(item.abs);
    } catch (error: any) {
      const reason = `核验时读不到：${String(error?.message ?? error)}`;
      return { state: "failed", line: `验证失败 ${item.label}：${reason}`, detail: reason };
    }
    if (!after.exists) {
      const reason = before.exists ? "核验时文件不存在（命令可能删掉了它）" : "核验时文件不存在";
      return { state: "failed", line: `验证失败 ${item.label}：${reason}`, detail: reason };
    }
    const missing = item.contains.filter((needle) => !after.text.includes(needle));
    const leaked = item.absent.filter((needle) => after.text.includes(needle));
    if (missing.length || leaked.length) {
      const reason = [
        missing.length ? `缺少 ${missing.map((n) => JSON.stringify(clip(n))).join("、")}` : "",
        leaked.length ? `仍然出现 ${leaked.map((n) => JSON.stringify(clip(n))).join("、")}` : "",
      ].filter(Boolean).join("；");
      return { state: "failed", line: `验证失败 ${item.label}：${reason}`, detail: reason, after };
    }
    const moved = before.exists ? before.sha256 !== after.sha256 : true;
    if (!moved)
      return { state: "unchanged", line: `已满足且无变化 ${item.label}：${after.bytes} 字节，内容与执行前一致`,
        detail: "原本已满足，本次无变化", after };
    return { state: "changed", line: `已验证变化 ${item.label}：${after.bytes} 字节`, after };
  };

  /** 逐文件上报证据：宿主据此决定「本轮文件」里给不给这一行。 */
  const reportVerified = (session: any, item: Planned, verdict: Verdict) => {
    try {
      if (typeof session?.evidence !== "function") return;
      if (verdict.state === "failed" || !verdict.after) {
        session.evidence({ kind: "file_write", path: item.abs, read_back: "failed",
          verify: "failed", detail: verdict.detail ?? "断言未通过",
          ...(verdict.after?.exists && item.contains.length + item.absent.length <= 8 &&
            [...item.contains, ...item.absent].every(value => value.length <= 160)
            ? { assertions: { contains: item.contains, absent: item.absent } } : {}) });
        return;
      }
      session.evidence({ kind: "file_write", path: item.abs,
        bytes: verdict.after.bytes, sha256: verdict.after.sha256,
        read_back: "ok", verify: verdict.state,
        ...(verdict.detail ? { detail: verdict.detail } : {}) });
    } catch { /* 证据上报失败不能改写工具结果 */ }
  };

  ctx.tools.register({
    name: "hands_list",
    description: "列出目录内容。path 省略时列出工作目录；depth 为递归层数，默认 1。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，可省略" },
        depth: { type: "number", minimum: 1, description: "递归层数，默认 1，上限 3；超过 3 会按 3 处理并标注" },
      },
      required: [],
    },
    danger: "safe",
    run: safe(async (args: any) => {
      const dir = guard(String(args?.path ?? base), "列目录");
      const rootInfo = await stat(dir).catch((error: any) => {
        if (error?.code === "ENOENT") throw new Error(`目录不存在：${dir}`);
        throw new Error(`列目录失败：${error?.message ?? error}`);
      });
      if (!rootInfo.isDirectory()) throw new Error(`这不是目录，是文件，请用 hands_read 读它：${dir}`);
      const asked = Number(args?.depth ?? 1);
      if (!Number.isInteger(asked) || asked < 1) {
        throw new Error(`depth 必须是 ≥1 的整数，收到 ${JSON.stringify(args?.depth)}`);
      }
      const depth = Math.min(asked, 3);
      const notes: string[] = [];
      if (asked > depth) notes.push(`depth 上限 3，已按 3 处理（请求的是 ${asked}）`);
      let entriesCut = false;
      const lines: string[] = [];
      const walk = async (at: string, level: number) => {
        const items = await readdir(at, { withFileTypes: true });
        if (items.length > 200) entriesCut = true;
        for (const it of items.slice(0, 200)) {
          lines.push(`${"  ".repeat(level)}${it.isDirectory() ? "[D]" : "[F]"} ${it.name}`);
          if (it.isDirectory() && level + 1 < depth) {
            await walk(resolve(at, it.name), level + 1).catch(() => {});
          }
        }
      };
      await walk(dir, 0);
      if (entriesCut) notes.push("每个目录最多列 200 项，多出来的没显示");
      const tail = notes.length ? `\n（${notes.join("；")}）` : "";
      return `${dir}\n${lines.join("\n") || "(空目录)"}${tail}`;
    }),
  });

  ctx.tools.register({
    name: "hands_read",
    description: "读取文本文件。offset 为起始行（从 0 开始），limit 为行数，默认 400 行。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", minimum: 0, description: "起始行，从 0 开始；超出总行数会报错" },
        limit: { type: "number", minimum: 1, description: "最多读几行，默认 400，上限 4000" },
      },
      required: ["path"],
    },
    danger: "safe",
    run: safe(async (args: any) => {
      const file = guard(String(args?.path ?? ""), "读文件");
      const info = await stat(file).catch((error: any) => {
        if (error?.code === "ENOENT") throw new Error(`文件不存在：${file}`);
        if (error?.code === "EACCES" || error?.code === "EPERM") throw new Error(`没有权限读：${file}`);
        throw new Error(`读不到 ${file}（${String(error?.code ?? error?.message ?? "未知")}）`);
      });
      if (info.isDirectory()) throw new Error("这是目录，请用 hands_list");
      const rawBuffer = await readFile(file);
      if (rawBuffer.byteLength === 0) return `${file}（空文件，0 字节）`;
      const lines = rawBuffer.toString("utf8").split(/\r?\n/);
      const total = lines.length;
      if (args?.offset !== undefined && args?.offset !== null) {
        const o = args.offset;
        if (typeof o !== "number" || !Number.isInteger(o) || o < 0) {
          throw new Error(`offset 必须是非负整数（从 0 开始），收到 ${JSON.stringify(o)}`);
        }
      }
      if (args?.limit !== undefined && args?.limit !== null) {
        const l = args.limit;
        if (typeof l !== "number" || !Number.isInteger(l) || l < 1) {
          throw new Error(`limit 必须是 ≥1 的整数，收到 ${JSON.stringify(l)}`);
        }
      }
      const offset = args?.offset == null ? 0 : (args.offset as number);
      const wantLimit = args?.limit == null ? 400 : (args.limit as number);
      const limit = Math.min(wantLimit, 4000);
      const limitNote = wantLimit > limit ? `；limit 上限 4000，已按 4000 处理（请求的是 ${wantLimit}）` : "";
      if (offset > total) {
        throw new Error(`offset ${offset} 超出范围：这个文件只有 ${total} 行（可用 0–${total}；等于 ${total} 表示已读完）`);
      }
      if (offset === total) {
        return `${file}（共 ${total} 行）${limitNote}\noffset ${offset} 已经在末尾，没有更多内容`;
      }
      const slice = lines.slice(offset, offset + limit);
      const end = offset + slice.length;
      const head = `${file}（第 ${offset + 1}–${end} 行，共 ${total} 行${limitNote}）`;
      const note = end < total ? `\n…… 还有 ${total - end} 行没读，接着用 offset=${end} ……` : "";
      return trim(`${head}\n${slice.join("\n")}${note}`, cfg.max_output_chars);
    }),
  });

  ctx.tools.register({
    name: "hands_write",
    description:
      "写文本文件，自动建父目录。append 为 true 时追加，否则覆盖。" +
      "覆盖或追加已有文件前，会先把原文备份到插件 data/backups（按天数与总量自动清理）；" +
      "给了 expected_sha256 时先比对当前文件哈希，不一致就拒写——用于防止盖掉别人刚做的改动。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean" },
        expected_sha256: {
          type: "string",
          description: "可选。当前文件的 sha256；不符则拒写。用于覆盖保护。",
        },
      },
      required: ["path", "content"],
    },
    danger: "full",
    run: safe(async (args: any, session: any) => {
      const file = guard(String(args?.path ?? ""), "写文件");
      await mkdir(dirname(file), { recursive: true });
      const append = Boolean(args?.append);
      const payload = Buffer.from(String(args?.content ?? ""), "utf8");

      // 版本比对先做：对不上就不能动文件，连备份也不该产生。
      const expected = typeof args?.expected_sha256 === "string"
        ? args.expected_sha256.trim().toLowerCase() : "";
      const before = await snapshot(file);
      if (expected) {
        if (!before.exists)
          throw new Error(`版本比对失败：${file} 当前不存在，却给了 expected_sha256，未写入`);
        if (before.sha256 !== expected)
          throw new Error(`版本比对失败：${file} 当前 sha256 是 ${String(before.sha256).slice(0, 12)}…，`
            + `与 expected_sha256 不符，未写入`);
      }

      // 覆盖/追加前留副本。备份失败要报出来，不能当作已经有了退路。
      let backup: { path: string; bytes: number; sha256: string } | null = null;
      if (before.exists) backup = await backupFile(file);

      await writeFile(file, payload, { flag: append ? "a" : "w" });
      // 写成功后立刻回读，通过宿主提供的通用证据契约上报操作事实：
      // 字节数与 sha256 只来自回读，不用写前估算；任务归属由宿主绑定，本插件不自报。
      // 覆盖模式直接比对回读字节与预期字节；追加模式只比对尾部那一段。
      let evidence: any;
      try {
        const back = await readFile(file);
        const tail = append ? back.subarray(Math.max(0, back.byteLength - payload.byteLength)) : back;
        const matched = tail.equals(payload);
        evidence = { kind: "file_write", path: file, bytes: back.byteLength,
          sha256: createHash("sha256").update(back).digest("hex"),
          read_back: matched ? "ok" : "failed",
          verify: matched ? "changed" : "failed",
          ...(matched ? {} : { error: append ? "追加后回读内容与写入不符" : "回读内容与写入内容不一致" }) };
      } catch (error: any) {
        evidence = { kind: "file_write", path: file, read_back: "failed", verify: "failed",
          error: String(error?.code ?? error?.message ?? "回读失败") };
      }
      // 上报失败不能改写工具本身的结果，这里只如实标一句。
      let reported = "unsupported";
      try {
        if (typeof session?.evidence === "function") { session.evidence(evidence); reported = "sent"; }
      } catch { reported = "failed"; }
      const info = await stat(file);
      const backupNote = backup
        ? `\n原文件已备份：${backup.path}（${backup.bytes} 字节，sha256 ${backup.sha256.slice(0, 12)}…）`
        : "";
      if (evidence.read_back === "ok")
        return `已写入 ${file}（${info.size} 字节，回读一致，证据 ${reported}）${backupNote}`;
      return `写入后回读失败：${file}（磁盘上 ${info.size} 字节，证据 ${reported}）。这条结果不能当作写入成功。${backupNote}`;
    }),
  });

  const runHands = async (args: any, session: any) => {
    const command = String(args?.command ?? "").trim();
    if (!command) throw new Error("command 不能为空");
    const lowered = command.toLowerCase();
    const blocked = cfg.deny_patterns.find((p: string) => lowered.includes(String(p).toLowerCase()));
    if (blocked) throw new Error(`命令被拒绝：命中禁止项「${blocked}」`);
    const cwd = guard(String(args?.cwd ?? base), "执行目录");
    const timeout = Math.min(Math.max(Number(args?.timeout_ms ?? cfg.timeout_ms), 1000), 600_000);

    // 参数、路径、基线都必须在执行命令之前定下来：参数错了不能已经动过文件。
    const planned = planVerify(args?.verify_files, cwd);
    const baselines = new Map<string, Snapshot>();
    for (const item of planned) baselines.set(item.abs, await snapshot(item.abs));

    const r = await runShell(command, cwd, timeout, session?.signal ?? ctx.signal, cfg.encoding_prelude !== false);
    const out = trim(r.stdout, cfg.max_output_chars);
    const err = trim(r.stderr, Math.floor(cfg.max_output_chars / 3));

    // 核验摘要放最前面，不被 stdout/stderr 的截断吃掉。
    const head: string[] = [
      `退出码 ${r.code}`,
    ];
    // 嵌套 -Command 的双引号里带 $ 时，外层会先展开、内层拿到字面量；
    // 这种错可能以退出码 0 结束，所以不管成功失败都要提示。
    const nestedDollar =
      /(?:^|[\s;&|])(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z]+\s+)*-command\s+"[^\r\n]*\$(?:[\w{?(])/i.test(
        command,
      );
    if (nestedDollar) {
      head.push(
        r.code !== 0
          ? "调用提示：hands_run 已在 PowerShell 内执行。嵌套 -Command 的双引号会先展开 $ 变量；请直接传 PowerShell 脚本。"
          : "调用提示：这条命令里嵌了 powershell -Command，双引号内的 $ 会被外层先展开。结果对不上就改成直接写 PowerShell 脚本。",
      );
    }
    const counts = { changed: 0, unchanged: 0, failed: 0 };
    if (planned.length) {
      const lines: string[] = [];
      for (const item of planned) {
        const verdict = await verifyFile(item, baselines.get(item.abs)!);
        if (verdict.state === "changed") counts.changed += 1;
        else if (verdict.state === "unchanged") counts.unchanged += 1;
        else counts.failed += 1;
        lines.push(verdict.line);
        reportVerified(session, item, verdict);
      }
      head.push(`--- 文件核验 --- 已验证变化 ${counts.changed}，已满足无变化 ${counts.unchanged}，验证失败 ${counts.failed}`);
      head.push(...lines);
      if (counts.failed) head.push("文件核验未通过：这次不能算全部完成。");
    }

    const text = [
      ...head,
      out ? `--- stdout ---\n${out}` : "",
      err ? `--- stderr ---\n${err}` : "",
    ].filter(Boolean).join("\n");

    return text;
  };

  const runTool: any = {
    name: "hands_run",
    description:
      "在允许目录内用 Windows PowerShell 执行 command，返回退出码、标准输出与错误输出。命令有超时与拒绝清单约束。" +
      "脚本先落成临时 .ps1 再以 -File 执行，双引号里的 $ 不会被外层展开；直接写 PowerShell 脚本，如 \"$value = 42; Write-Output $value\"。" +
      "调用外部程序（node、git 等）照常写；不要再包一层 powershell -Command。" +
      "改文件时用 verify_files 声明预期内容，命令跑完会回读核验并逐文件报告。",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "直接传 PowerShell 脚本或外部程序命令，无需用 powershell -Command 包裹。" },
        cwd: { type: "string", description: "工作目录，默认工作目录" },
        timeout_ms: { type: "number", description: "超时毫秒，默认 60000" },
        verify_files: {
          type: "array",
          description:
            "写后核验：声明这次命令应该改动哪些文件，以及必须出现/必须消失的字面量。最多 10 个，" +
            "相对路径以 cwd 为基准。省略时只报告命令执行结果，不验证文件。",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "文件路径" },
              contains: { type: "array", items: { type: "string" }, description: "写后必须出现的字面量" },
              absent: { type: "array", items: { type: "string" }, description: "写后必须消失的字面量" },
            },
            required: ["path"],
          },
        },
      },
      required: ["command"],
    },
    danger: "full",
    run: async (args: any, session: any) => {
      try {
        return await runHands(args, session);
      } catch (error: any) {
        return `错误：${error?.message ?? String(error)}`;
      }
    },
  };

  // 命令正文走临时输出：只当轮可见，长期记忆里只留一条极简回执。
  // 正文动辄几十 KB，一旦入档就会在之后每一轮被重发，上下文成倍膨胀。
  // 宿主要求临时工具必须返回 { content, receipt }，且 receipt 必须是有界 JSON。
  const transientCapable = typeof (ctx.tools as any).registerTransient === "function";
  const transientOn = cfg.transient_output !== false && transientCapable;

  const runTransient: any = {
    ...runTool,
    description:
      runTool.description +
      "命令输出只在本次回复内可见，长期记忆里只留一条极简回执（退出码、核验计数、耗时）。",
    run: async (args: any, session: any) => {
      const started = Date.now();
      let text: string;
      let ok = true;
      try {
        text = await runHands(args, session);
        ok = !/^退出码 [1-9]/.test(text);
      } catch (error: any) {
        text = `错误：${error?.message ?? String(error)}`;
        ok = false;
      }
      // 回执只放能核账的字段：不抄正文、不抄 stderr、不抄命令全貌。
      const exit = /^退出码 (-?\d+)/.exec(text);
      const verify = /已验证变化 (\d+)，已满足无变化 (\d+)，验证失败 (\d+)/.exec(text);
      const receipt: any = {
        tool: "hands_run",
        ok,
        exit_code: exit ? Number(exit[1]) : null,
        command_head: String(args?.command ?? "").replace(/\s+/g, " ").slice(0, 120),
        output_chars: text.length,
        ms: Date.now() - started,
      };
      const cwd = String(args?.cwd ?? "").trim();
      if (cwd) receipt.cwd = cwd.slice(0, 200);
      if (verify) {
        receipt.verified = {
          changed: Number(verify[1]),
          unchanged: Number(verify[2]),
          failed: Number(verify[3]),
        };
      }
      return { content: text, receipt };
    },
  };

  if (transientOn) ctx.tools.registerTransient(runTransient);
  else ctx.tools.register(runTool);

  ctx.effect(() => () => {
    ctx.logger.info("hands 已清理");
  });
}
