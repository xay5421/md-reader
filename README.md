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

## 开发

```powershell
npm install
npm run tauri dev
```

## 构建安装包

```powershell
npm run tauri build
# 产物: src-tauri/target/release/bundle/nsis/md-reader_x.y.z_x64-setup.exe
```

依赖 Rust（MSVC 工具链）与 Node.js。
