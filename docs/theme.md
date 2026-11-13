# M6.5 · 动态主题与视觉重做

> M3.5 那套「四套静态皮肤 + 亮暗成对」已经全部下线。现在只有**一个主题维度：背景**。
> 背景是一段循环播放的水墨动画（或一张静态图），切换时交叉渐隐；界面统一暗色玻璃，强调色跟着主题走。

## 三套主题

| id | 名字 | 类型 | 素材 | 强调色 | 遮罩 |
| --- | --- | --- | --- | --- | --- |
| `ink-abyss` | 临渊 | 动态视频 | `ink-abyss.mp4`（水墨 · 苍青 · 鹤影） | `#5d94b8` | 0.52 |
| `ink-mist` | 烟雨 | 动态视频 | `ink-mist.mp4`（水墨 · 苔青 · 檐下） | `#6f9a78` | 0.54 |
| `sakura` | 花影 | 静态图 | `sakura.jpg`（四月 · 樱） | `#b5617a` | 0.6 |

- 素材放在 `apps/web/public/backgrounds/`，由 `themeAsset()` 拼 `${BASE_URL}backgrounds/…`，
  这样 dev（`/`）与打包（`./`）都能取到。
- 视频原始素材是 4K 60fps、单段 56MB；用 `ffmpeg-static` 转成 1440 宽 / 30fps / crf30 / 无音轨后
  是 **2.83MB 与 1.78MB**，顺带抽了同名的 `.jpg` 当封面（`poster`）。
- 静图是低分辨率素材，用 `blur(1.5px)` + 慢速推镜（52s Ken Burns）掩盖放大痕迹。

## 只有一套明暗

- 亮色彻底移除：`document.documentElement` 永远带 `.dark`，原生控件由 `nativeTheme.themeSource = 'dark'` 固定。
- 侧栏不再有月亮/太阳按钮；`olivia.skin` / `olivia.theme` 旧键在首次加载时清掉，新键是 `olivia.theme.v3`。
- Tailwind 的 `dark-*` 调色板改成中性石墨（`#0a0e12` / `#eef2f4`），所有主题共用同一套表面材质；
  只有强调色、鎏金与页面底色随主题变。

## 强调色怎么生效

Tailwind 的颜色是编译期常量，所以 `dark-accent` / `dark-gold` 这类原子类由 `base.css` 末尾的一层覆盖
改成读 `var(--olivia-accent)` / `var(--olivia-gold)`（含常见的半透明变体）。
组件里原本就写 `var(--olivia-accent)` 的地方（按钮、品牌标、装饰线）不用改。

## 渐显与切换

`BackgroundLayer` 同时挂两层：旧主题留在下面，新主题从 `opacity 0 → 1` 淡入（1.5s，带一点去饱和），
1.6s 后卸载旧层，视觉上是**交叉溶解**。
视频 `canplay` 之后才淡入，封面 `poster` 垫在后面，不会出现黑屏硬切。
静图走 `scene-kenburns` 慢推镜。

## 水波纹

`RippleLayer` 是一块 `pointer-events: none` 的全屏 canvas：每次 `pointerdown` 在点击处画三圈扩散水纹
外加一点中心高光，1.15s 淡出；没有波纹时停掉 rAF，不空转。
颜色取 `--olivia-accent-rgb`（主题切换后自动跟随）；`prefers-reduced-motion` 下整层关闭。

## 可读性

正文直接浮在动画上会看不清，所以：

- 每套主题有一层 `scrim`（径向 + 横向 + 纵向三段渐变），按主题的 `scrim` 浓度与基色计算；
- 对话区额外有一块 `.chat-veil`：中间压暗、左右羽化、`backdrop-filter: blur(7px)`，
  既保证正文对比度，又让背景在两侧透出来；
- 用户气泡改用深色玻璃（`bg-black/35` + `blur`），不再依赖亮色底。

## 字体

`apps/web/src/assets/fonts/AaGuDianKeBenSong.ttf`（古典刻本宋油墨版，7.6MB）通过 `styles/fonts.css`
里的 `@font-face` 注册为 `Olivia Song`，并排在 Tailwind `fontFamily.sans` / `serif` 的第一位。
代码块继续用 JetBrains Mono / Consolas。

## 加一套主题

1. 把素材丢进 `apps/web/public/backgrounds/`；
2. 在 `components/theme/themes.ts` 的 `THEMES` 里加一条（`kind`、`file`、`poster`、`position`、`scrim`、`palette`）；
3. 完事——`ThemePicker` 会自己多一个磁贴，颜色与水位也自动跟上。

## 验证

```bash
npm run build:web          # 502 modules，CSS 87 kB(gzip 16 kB)，JS 440 kB(gzip 145 kB)
node scripts/electron-run.cjs scripts/demo-theme.cjs   # 三套主题 + 水波纹截图，产物在 docs/screenshots-m7
```

`demo-theme.cjs` 会顺带断言：视频在播（`paused=false`、`readyState=4`）、图层透明度为 1、
字体确实是 `Olivia Song`、`--olivia-accent` 跟着主题变、水波纹层存在。

## 仍然要注意的两个坑

1. **Tailwind 会 purge「拼出来的类名」**：Markdown 的 `md-h${level}` 曾经整条消失，现在用 `data-level` 属性选择器。
2. **纯 CSS 里 `@apply` 任意值不可靠**：只在 CSS 里引用的 `text-[16px]` 之类不保证生成，Markdown 区块改成了原生 CSS。
