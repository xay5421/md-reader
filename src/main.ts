import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./styles.css";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ask,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  readTextFile,
  writeTextFile,
  watchImmediate,
  type UnwatchFn,
} from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";

const OPENABLE_EXTENSIONS = ["md", "markdown", "txt"];
const APP_NAME = "md-reader";

// ---------- state ----------

let crepe: Crepe | null = null;
let currentPath: string | null = null;
let savedContent = "";
let dirty = false;
let readonly = true; // 默认阅读模式
let unwatch: UnwatchFn | null = null;
let lastWriteAt = 0; // 忽略自己写盘触发的 watch 事件（省一次文件读取）
let watchTimer: number | undefined;
let openSeq = 0; // 打开操作序号，防止并发打开时旧内容覆盖新内容

// 导航历史（链接跳转/打开文件时记录，Alt+←/→ 或鼠标侧键前进后退）
const history: string[] = [];
let historyIndex = -1;

const el = {
  editor: document.getElementById("editor")!,
  welcome: document.getElementById("welcome")!,
  statusFile: document.getElementById("status-file")!,
  statusMode: document.getElementById("status-mode")!,
  statusDirty: document.getElementById("status-dirty")!,
};

// ---------- ui helpers ----------

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
}

/** 把文档里的相对路径解析为绝对路径（基于当前文件所在目录） */
function resolveRelative(rel: string): string | null {
  const decoded = decodeURI(rel);
  // 已是绝对路径（盘符 / UNC）
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith("\\\\")) {
    return decoded;
  }
  if (!currentPath) return null;
  const parts = `${dirName(currentPath)}/${decoded}`.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("\\");
}

/** 图片 URL 代理：相对路径 → asset protocol；网络/内联资源原样返回 */
function proxyImageUrl(url: string): string {
  if (/^(https?:|data:|blob:|asset:)/i.test(url) || url.includes("asset.localhost")) {
    return url;
  }
  const abs = resolveRelative(url);
  return abs ? convertFileSrc(abs) : url;
}

function setStatus(text: string) {
  el.statusFile.textContent = text;
}

async function refreshUi() {
  document.documentElement.dataset.readonly = String(readonly);
  el.welcome.style.display = currentPath ? "none" : "flex";
  setStatus(currentPath ?? "未打开文件");
  el.statusMode.textContent = currentPath ? (readonly ? "阅读" : "编辑") : "";
  el.statusDirty.textContent = dirty ? "●" : "";
  const title = currentPath
    ? `${dirty ? "• " : ""}${fileName(currentPath)} - ${APP_NAME}`
    : APP_NAME;
  await getCurrentWindow().setTitle(title);
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    void refreshUi();
  }
}

/** 有未保存修改时向用户确认是否放弃；返回 true 表示可以继续 */
async function confirmDiscardChanges(): Promise<boolean> {
  if (!dirty) return true;
  return ask("当前文件有未保存的修改，放弃这些修改吗？", {
    title: APP_NAME,
    kind: "warning",
  });
}

// ---------- editor ----------

async function mountEditor(markdown: string) {
  const scrollY = window.scrollY;
  if (crepe) {
    crepe.destroy();
    crepe = null;
    el.editor.innerHTML = "";
  }
  const instance = new Crepe({
    root: el.editor,
    defaultValue: markdown,
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        // 数学块默认只显示渲染结果（Typora 行为）；
        // 编辑模式下可通过悬停工具按钮展开 LaTeX 源码
        previewOnlyByDefault: true,
      },
      [Crepe.Feature.ImageBlock]: {
        // 相对路径图片走 asset protocol 显示，markdown 源不受影响
        proxyDomURL: proxyImageUrl,
      },
    },
  });
  // 用 updated（文档变更）置脏，避免 markdownUpdated 每次击键全文序列化
  instance.on((listener) => {
    listener.updated((_ctx, doc, prevDoc) => {
      // 只读模式下的文档变更只可能是渲染归一化（如数学预览），不算脏
      if (!readonly && prevDoc && !doc.eq(prevDoc)) markDirty();
    });
  });
  await instance.create();
  instance.setReadonly(readonly);
  crepe = instance;
  window.scrollTo({ top: scrollY });
}

// ---------- file ops ----------

async function openFile(path: string, fromHistory = false): Promise<boolean> {
  if (!(await confirmDiscardChanges())) return false;
  const seq = ++openSeq;
  let content: string;
  try {
    content = await readTextFile(path);
  } catch (e) {
    setStatus(`打开失败: ${e}`);
    return false;
  }
  if (seq !== openSeq) return false; // 期间有更新的打开操作，放弃本次
  currentPath = path;
  savedContent = content;
  dirty = false;
  if (!fromHistory && history[historyIndex] !== path) {
    history.length = historyIndex + 1; // 丢弃前进分支
    history.push(path);
    historyIndex = history.length - 1;
  }
  await mountEditor(content);
  await startWatch(path);
  await refreshUi();
  return true;
}

/** 历史前进/后退（delta = -1 后退，+1 前进） */
async function goHistory(delta: number) {
  const idx = historyIndex + delta;
  if (idx < 0 || idx >= history.length) return;
  const prev = historyIndex;
  historyIndex = idx;
  if (!(await openFile(history[idx]!, true))) historyIndex = prev;
}

async function saveFile() {
  if (!crepe) return;
  if (currentPath && !dirty) return; // 已有文件且无修改：跳过写盘
  let path = currentPath;
  const isSaveAs = !path;
  if (!path) {
    path = await saveDialog({
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!path) return;
  }
  const md = crepe.getMarkdown();
  lastWriteAt = Date.now();
  try {
    await writeTextFile(path, md);
  } catch (e) {
    setStatus(`保存失败: ${e}`);
    return;
  }
  currentPath = path;
  savedContent = md;
  dirty = false;
  if (isSaveAs) {
    await startWatch(path); // 文件已存在后再 watch
    history.length = historyIndex + 1;
    history.push(path);
    historyIndex = history.length - 1;
  }
  await refreshUi();
}

async function chooseAndOpen() {
  const path = await openDialog({
    multiple: false,
    filters: [
      { name: "Markdown", extensions: OPENABLE_EXTENSIONS },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (typeof path === "string") await openFile(path);
}

// ---------- external change watch ----------

async function startWatch(path: string) {
  unwatch?.();
  unwatch = null;
  clearTimeout(watchTimer); // 丢弃上一个文件遗留的 pending 重载
  unwatch = await watchImmediate(path, () => {
    // 自己保存触发的事件：跳过（内容比较兜底，这里只是省一次读盘）
    if (Date.now() - lastWriteAt < 800) return;
    // debounce：外部编辑器保存往往触发多个事件
    clearTimeout(watchTimer);
    watchTimer = window.setTimeout(() => void reloadFromDisk(), 150);
  });
}

async function reloadFromDisk() {
  if (!currentPath) return;
  let content: string;
  try {
    content = await readTextFile(currentPath);
  } catch {
    return; // 文件被删除/占用，忽略
  }
  if (content === savedContent) return;
  if (dirty) {
    // 本地有未保存修改，不覆盖，仅提示
    setStatus(`${currentPath}（磁盘文件已被外部修改）`);
    return;
  }
  savedContent = content;
  await mountEditor(content);
  await refreshUi();
}

// ---------- shortcuts ----------

document.addEventListener("keydown", (e) => {
  // Alt+←/→：历史后退/前进
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      void goHistory(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      void goHistory(1);
    }
    return;
  }
  if (!e.ctrlKey || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === "o") {
    e.preventDefault();
    void chooseAndOpen();
  } else if (key === "s") {
    e.preventDefault();
    void saveFile();
  } else if (key === "e" && currentPath) {
    e.preventDefault();
    readonly = !readonly;
    crepe?.setReadonly(readonly);
    void refreshUi();
  }
});

// 鼠标侧键（后退 button=3 / 前进 button=4）
document.addEventListener("mouseup", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    void goHistory(-1);
  } else if (e.button === 4) {
    e.preventDefault();
    void goHistory(1);
  }
});

// ---------- links: 外部浏览器打开，阻止 webview 整页导航 ----------

document.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    void openUrl(href);
    return;
  }
  if (href.startsWith("#")) return; // 页内锚点交给默认行为
  // 相对/本地路径：markdown 文件在阅读器内打开，其他类型仅提示
  e.preventDefault();
  const target = resolveRelative(href.split("#")[0] ?? href);
  if (!target) return;
  const ext = target.split(".").pop()?.toLowerCase() ?? "";
  if (OPENABLE_EXTENSIONS.includes(ext)) {
    void openFile(target);
  } else {
    setStatus(`不支持在阅读器中打开: ${fileName(target)}`);
  }
});

// ---------- drag & drop ----------

void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type !== "drop") return;
  const first = event.payload.paths[0];
  if (!first) return;
  const ext = first.split(".").pop()?.toLowerCase() ?? "";
  if (OPENABLE_EXTENSIONS.includes(ext)) {
    void openFile(first);
  } else {
    setStatus(`不支持的文件类型: ${fileName(first)}`);
  }
});

// ---------- window close: 未保存修改确认 ----------

void getCurrentWindow().onCloseRequested(async (event) => {
  try {
    if (!(await confirmDiscardChanges())) event.preventDefault();
  } catch {
    // 确认对话框异常时放行关闭，绝不把窗口卡死
  }
});

// ---------- startup ----------

el.welcome.addEventListener("click", () => void chooseAndOpen());

async function init() {
  try {
    await refreshUi();
    const cliPath = await invoke<string | null>("cli_open_path");
    if (cliPath) await openFile(cliPath);
  } catch (e) {
    setStatus(`初始化失败: ${e}`);
  }
}

void init();
