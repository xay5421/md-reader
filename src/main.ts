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

const APP_NAME = "md-reader";
const OPENABLE_EXTENSIONS = ["md", "markdown", "txt"];
const OUTLINE_PREF_KEY = "md-reader.outline";

const appWindow = getCurrentWindow();

// ---------- state ----------

let crepe: Crepe | null = null;
let currentPath: string | null = null;
let savedContent = "";
let dirty = false;
let readonly = true; // 默认阅读模式
let unwatch: UnwatchFn | null = null;
let lastWriteAt = 0; // 忽略自己写盘触发的 watch 事件（省一次文件读取）
let openSeq = 0; // 打开操作序号，防止并发打开时旧内容覆盖新内容

// 导航历史（链接跳转/打开文件时记录，Alt+←/→ 或鼠标侧键前进后退）
const navHistory: string[] = [];
let historyIndex = -1;

// 大纲侧边栏（Ctrl+Shift+1 切换，偏好持久化）
let outlineVisible = localStorage.getItem(OUTLINE_PREF_KEY) !== "0";
let outlineHeadings: HTMLElement[] = [];

const el = {
  editor: document.getElementById("editor")!,
  welcome: document.getElementById("welcome")!,
  outlineToggle: document.getElementById("outline-toggle")!,
  outlineList: document.getElementById("outline-list")!,
  statusFile: document.getElementById("status-file")!,
  statusMode: document.getElementById("status-mode")!,
  statusDirty: document.getElementById("status-dirty")!,
};

// ---------- generic helpers ----------

/** debounce 包装，附带 cancel() 供切换上下文时丢弃 pending 调用 */
function debounce(fn: () => void, ms: number) {
  let timer: number | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}

/** decodeURIComponent 的不抛异常版本（链接里可能出现非法 % 序列） */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
}

function extOf(p: string): string {
  return p.split(".").pop()?.toLowerCase() ?? "";
}

function isOpenable(p: string): boolean {
  return OPENABLE_EXTENSIONS.includes(extOf(p));
}

/** 把文档里的相对路径解析为绝对路径（基于当前文件所在目录） */
function resolveRelative(rel: string): string | null {
  const decoded = safeDecode(rel);
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

/** GitHub 风格 slug：小写、去标点（保留中日韩等文字）、空格转连字符 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

// ---------- ui ----------

function setStatus(text: string) {
  el.statusFile.textContent = text;
}

let lastTitle = "";

async function refreshUi() {
  const root = document.documentElement;
  root.dataset.readonly = String(readonly);
  root.dataset.hasfile = String(!!currentPath);
  const outlineShown = outlineVisible && !!currentPath;
  const outlineWasShown = root.dataset.outline === "true";
  root.dataset.outline = String(outlineShown);
  // 面板从隐藏变为可见时重算宽度（隐藏状态下测不了尺寸）
  if (outlineShown && !outlineWasShown) fitOutlineWidth();

  el.welcome.style.display = currentPath ? "none" : "flex";
  setStatus(currentPath ?? "未打开文件");
  el.statusMode.textContent = currentPath ? (readonly ? "阅读" : "编辑") : "";
  el.statusDirty.textContent = dirty ? "●" : "";

  const title = currentPath
    ? `${dirty ? "• " : ""}${fileName(currentPath)} - ${APP_NAME}`
    : APP_NAME;
  if (title !== lastTitle) {
    lastTitle = title;
    await appWindow.setTitle(title);
  }
}

/**
 * 更新 dirty 并同步到 Rust 侧。
 * 关闭确认由 Rust 处理（见 lib.rs）：webview 被系统挂起/崩溃（黑屏）
 * 时窗口依然可以正常关闭，不会因等待 JS 回应而卡死。
 */
function setDirty(value: boolean) {
  dirty = value;
  void invoke("set_dirty", { dirty: value }).catch(() => {});
}

function markDirty() {
  if (!dirty) {
    setDirty(true);
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

// ---------- outline ----------

function scrollToHeading(h: HTMLElement) {
  h.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toggleOutline() {
  outlineVisible = !outlineVisible;
  localStorage.setItem(OUTLINE_PREF_KEY, outlineVisible ? "1" : "0");
  void refreshUi();
}

function rebuildOutline() {
  outlineHeadings = Array.from(
    el.editor.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
  ).filter((h) => (h.textContent ?? "").trim() !== "");
  el.outlineList.innerHTML = "";
  if (outlineHeadings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "（无标题）";
    el.outlineList.append(empty);
    return;
  }
  for (const h of outlineHeadings) {
    const btn = document.createElement("button");
    const text = h.textContent ?? "";
    btn.className = `lv${h.tagName[1]}`;
    btn.textContent = text;
    btn.title = text;
    btn.addEventListener("click", () => scrollToHeading(h));
    el.outlineList.append(btn);
  }
  fitOutlineWidth();
  updateOutlineActive();
}

/** 大纲宽度自适应：按最长标题定宽，夹在 [180px, min(420px, 窗口 38%)] */
function fitOutlineWidth() {
  if (document.documentElement.dataset.outline !== "true") return;
  const buttons = Array.from(
    el.outlineList.querySelectorAll<HTMLElement>("button")
  );
  // 先批量写、再批量读、最后批量还原，全程只触发两次 reflow
  for (const b of buttons) b.style.width = "max-content";
  const max = buttons.reduce((m, b) => Math.max(m, b.offsetWidth), 0);
  for (const b of buttons) b.style.width = "";
  const cap = Math.min(420, Math.floor(window.innerWidth * 0.38));
  const w = Math.min(Math.max(max + 28, 180), cap); // +28: 列表内边距+滚动条
  document.documentElement.style.setProperty("--outline-width", `${w}px`);
}

/** 滚动高亮：视口顶部附近最后一个已越过的标题为当前章节 */
function updateOutlineActive() {
  if (outlineHeadings.length === 0) return;
  let active = 0;
  for (let i = 0; i < outlineHeadings.length; i++) {
    if (outlineHeadings[i]!.getBoundingClientRect().top <= 90) active = i;
    else break;
  }
  const buttons = el.outlineList.children;
  for (let i = 0; i < buttons.length; i++) {
    buttons[i]!.classList.toggle("active", i === active);
  }
}

/** 页内锚点跳转：同时兼容 GitHub 风格 slug 和 Milkdown 生成的标题 id */
function scrollToAnchor(fragment: string): void {
  const raw = safeDecode(fragment);
  const want = slugify(raw);
  const hit = outlineHeadings.find(
    (h) => h.id === raw || slugify(h.textContent ?? "") === want
  );
  if (hit) scrollToHeading(hit);
  else setStatus(`未找到锚点: #${raw}`);
}

const scheduleOutlineRebuild = debounce(rebuildOutline, 300);

// ---------- editor ----------

/** 图片 URL 代理：相对路径 → asset protocol；网络/内联资源原样返回 */
function proxyImageUrl(url: string): string {
  if (
    /^(https?:|data:|blob:|asset:)/i.test(url) ||
    url.includes("asset.localhost")
  ) {
    return url;
  }
  const abs = resolveRelative(url);
  return abs ? convertFileSrc(abs) : url;
}

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
      scheduleOutlineRebuild();
    });
  });
  await instance.create();
  instance.setReadonly(readonly);
  crepe = instance;
  window.scrollTo({ top: scrollY });
  rebuildOutline();
}

// ---------- history ----------

function pushHistory(path: string) {
  if (navHistory[historyIndex] === path) return;
  navHistory.length = historyIndex + 1; // 丢弃前进分支
  navHistory.push(path);
  historyIndex = navHistory.length - 1;
}

/** 历史前进/后退（delta = -1 后退，+1 前进） */
async function goHistory(delta: number) {
  const idx = historyIndex + delta;
  if (idx < 0 || idx >= navHistory.length) return;
  const prev = historyIndex;
  historyIndex = idx;
  if (!(await openFile(navHistory[idx]!, true))) historyIndex = prev;
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
  setDirty(false);
  if (!fromHistory) pushHistory(path);
  await mountEditor(content);
  await startWatch(path);
  await refreshUi();
  return true;
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
  setDirty(false);
  if (isSaveAs) {
    await startWatch(path); // 文件已存在后再 watch
    pushHistory(path);
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

const scheduleReload = debounce(() => void reloadFromDisk(), 150);

let watchSeq = 0; // 防止并发 startWatch 竞态泄漏旧 watcher

async function startWatch(path: string) {
  const seq = ++watchSeq;
  unwatch?.();
  unwatch = null;
  scheduleReload.cancel(); // 丢弃上一个文件遗留的 pending 重载
  try {
    const stop = await watchImmediate(path, () => {
      // 自己保存触发的事件：跳过（内容比较兜底，这里只是省一次读盘）
      if (Date.now() - lastWriteAt < 800) return;
      // debounce：外部编辑器保存往往触发多个事件
      scheduleReload();
    });
    if (seq !== watchSeq) {
      // await 期间又发起了新的 watch：本次已过期，立即释放
      stop();
      return;
    }
    unwatch = stop;
  } catch {
    // watch 失败不影响文件打开，仅失去外部变更热重载
  }
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

// ---------- events ----------

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
  // Ctrl+Shift+1：大纲开关（用 code 判断，Shift+1 的 key 是 "!"）
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Digit1") {
    e.preventDefault();
    toggleOutline();
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

// 链接点击：外链走系统浏览器，锚点页内跳转，相对路径在阅读器内打开
document.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    void openUrl(href);
    return;
  }
  if (href.startsWith("#")) {
    e.preventDefault();
    scrollToAnchor(href.slice(1));
    return;
  }
  e.preventDefault();
  const [pathPart = "", fragment] = href.split("#");
  const target = resolveRelative(pathPart);
  if (!target) return;
  if (isOpenable(target)) {
    void openFile(target).then((ok) => {
      // 跨文件锚点：打开后跳到对应标题（延迟等渲染稳定）
      if (ok && fragment) setTimeout(() => scrollToAnchor(fragment), 100);
    });
  } else {
    setStatus(`不支持在阅读器中打开: ${fileName(target)}`);
  }
});

// 拖拽打开
void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type !== "drop") return;
  const first = event.payload.paths[0];
  if (!first) return;
  if (isOpenable(first)) {
    void openFile(first);
  } else {
    setStatus(`不支持的文件类型: ${fileName(first)}`);
  }
});

// 滚动时更新大纲高亮（rAF 节流）
let scrollRaf = 0;
window.addEventListener(
  "scroll",
  () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updateOutlineActive();
    });
  },
  { passive: true }
);

window.addEventListener("resize", debounce(fitOutlineWidth, 150));

el.outlineToggle.addEventListener("click", toggleOutline);
el.welcome.addEventListener("click", () => void chooseAndOpen());

// 窗口关闭确认在 Rust 侧处理（lib.rs on_window_event）。
// 不要在这里注册 onCloseRequested：JS 关闭监听会让关闭流程依赖
// webview 存活，webview 黑屏/挂起后窗口将永远无法关闭。

// ---------- startup ----------

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
