# md-reader

轻量 Markdown 阅读器 / 编辑器，基于 Tauri 2 + TypeScript + [Milkdown Crepe](https://milkdown.dev/)。
观感对齐 Typora GitHub 主题，默认只读阅读模式，安装包约 4 MB。

## 功能

- 默认阅读模式，`Ctrl+E` 切换编辑，`Ctrl+S` 保存，`Ctrl+O` 打开
- LaTeX 数学公式（KaTeX，只读时仅显示渲染结果）
- 相对路径支持：`./other.md` 链接在阅读器内打开，相对路径图片正常显示
- 导航历史：`Alt+←` / `Alt+→` 或鼠标侧键前进后退
- 文件被外部编辑器修改时自动热重载（有未保存修改时仅提示，不覆盖）
- 拖拽打开、`.md` / `.markdown` 文件关联、未保存修改关闭确认

## 安装

### 方式一：安装包（推荐）

从 [Releases](../../releases) 下载 `md-reader_x.y.z_x64-setup.exe`，双击安装：

- 按用户安装（`%LOCALAPPDATA%\md-reader`），无需管理员权限
- 自动注册 `.md` / `.markdown` 文件关联和开始菜单快捷方式
- 升级直接运行新版安装包覆盖即可，无需先卸载

卸载：**设置 → 应用 → md-reader → 卸载**，或运行安装目录下的 `uninstall.exe`。

### 方式二：从源码构建

环境要求：

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/)（Windows 上需 MSVC 工具链，即 Visual Studio C++ 生成工具）

```powershell
git clone <本仓库地址>
cd md-reader
npm install
npm run tauri build
# 安装包产物: src-tauri/target/release/bundle/nsis/md-reader_x.y.z_x64-setup.exe
# 免安装版:   src-tauri/target/release/md-reader.exe
```

> Windows 10/11 一般自带 WebView2 运行时；缺失时安装器会引导安装。

## 开发

```powershell
npm install
npm run tauri dev
```

## License

[MIT](LICENSE)
