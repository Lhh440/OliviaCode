# M3.5 · 四套皮肤与布局改版

> M3 之后先把「长得像 Codex」这件事做扎实：主题从两套（light/dark）扩成四套完整皮肤，
> 侧栏、输入框、消息流重新排布，设置页从旧样式表迁到 Tailwind，旧的 `shell.css` / `theme.css` 退休。

## 四套皮肤

每套皮肤 = 一张版画底图 + 一层纹样 + 一组强调色。亮暗成对，组内一键互换。

| id | 名字 | 明暗 | 组 | 底图 | 强调色 | 纹样 |
| --- | --- | --- | --- | --- | --- | --- |
| `angel` | 钴蓝天使 | 亮 | 工坊 atelier | `light-angel.jpg` | `#2f5bd7` 钴蓝 | 放射日光 |
| `collage` | 朱红拼贴 | 暗 | 工坊 atelier | `dark-surreal.jpg` | `#f0354a` 朱砂 | 眼轮 |
| `lily` | 白百合 | 亮 | 祷歌 litany | `lily-litany.jpg` | `#413b33` 墨褐 | 蕾丝 |
| `madonna` | 荆棘圣母 | 暗 | 祷歌 litany | `madonna-gloria.jpg` | `#d8323f` 深红 | 星屑 |

- 切换方式：侧栏调色板图标打开主题面板；月亮/太阳按钮在**同组内**亮暗互换。
- 选择存在 `localStorage['olivia.skin']`；旧版本只存 `olivia.theme`（light/dark），首次加载时自动映射到 `angel` / `collage` 并清掉旧键。
- 皮肤决定 `document.documentElement.dataset.skin` 与 `.dark` 类，同时把 `--olivia-accent` / `--olivia-accent-strong` / `--olivia-gold` 三个 CSS 变量写到根节点上；组件里的 `var(--olivia-accent)` 跟着变。

皮肤定义在 `apps/web/src/components/theme/skins.ts` 一个数组里，加一套皮肤只需要：

1. 往 `apps/web/src/assets/backgrounds/` 放一张底图；
2. 在 `SKINS` 里加一条（`art` 控制位置、滤镜、混色、遮罩起点，`box`/`fadeY` 用于极宽的横带图）；
3. 在 `FAMILIES` 的映射里确认它属于哪个组——同组必须一亮一暗，否则 `pairedSkin` 会退回自己。

## 布局

- **侧栏**：品牌区（Logo + 皮肤名 + 主题/明暗按钮）→ 新建任务 → 四个导航（任务/工作流/Git/设置）→ 按状态分组的任务列表 → 底部工作区与「演示模式」标记。
- **对话**：欢迎页居中（标题 + 四张起步卡 + 绑定工作区），有消息后切成单栏消息流；输入框一体化——模型、审批策略、项目位置、发送/停止都在框内，底部一行显示轮次、步数、token 与上下文占用。
- **面板**：统一到 `.panel` / `.panel-strong` / `.field-input` / `.btn-solid` 这组原语，写在 `styles/themes/base.css` 的 `@layer components` 里，亮暗各一套 `light:` / `dark:` 变体。
- **设置**：四张卡片（模型接入 / 执行与审批 / Git 凭据 / 关于）全部用 Tailwind + framer-motion 重写，旧的 `.settings-page` / `.card` 样式表已删除。

## 截图

```bash
npm run build:web
electron scripts/capture-pages.cjs        # 四套首屏 + 主题面板 + 设置/工作流/Git，产物在 docs/screenshots-v3
electron scripts/capture-v2.cjs           # 带对话态的整套截图，需要真实模型端点
```

`capture-pages.cjs` 不需要模型，跑完可以直接提交。写这类截图脚本时有两个 Electron 的坑，已在脚本里处理：

1. **隐藏窗口不推进 rAF**：`show: false` 时 framer-motion 的淡入会停在 `opacity: 0`，截出来是空面板。脚本里 `setBackgroundThrottling(false)` 并把窗口挪到屏幕外 `showInactive()`。
2. **CSS 过渡停在中途**：同样因为窗口不可见，`transition` 会一直「running」，拍到的是从亮色往暗色过渡途中的灰。截图前注入一段 `transition: none !important` 的样式把过渡冻住（不要连 `animation` 一起关，framer-motion 的浮层用的是 WAAPI）。

## 验证

- `npm run typecheck`：前端 + 主进程严格检查通过。
- `npm run build:web`：496 个模块，CSS 66.0 kB（gzip 12.4 kB）。
- 四套皮肤在 1480×940 下逐页截图核对，见 `docs/screenshots-v3/`。
