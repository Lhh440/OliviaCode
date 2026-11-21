# 主题 · 黑鱼白水 / 白鱼黑水（koi）

> 「四套静态皮肤」和「三套视频主题」都已经下线。背景不再是视频或图片——
> 水面和鱼由 canvas 现场排出来：鱼身是一格一格压着随机字符的方形字块，
> 明暗靠抖动分级。整套视觉只有两件事：水的底色，和鱼的明度。
> 两套主题互为负片，共享同一套几何。

## 两套主题

| id | 名字 | mode | 鱼明度 fishAlpha | 一句话 |
| --- | --- | --- | --- | --- |
| `koi-light` | 黑鱼白水 | light | 0.8 | 纸白的水，墨黑的鱼，淡墨字屑 |
| `koi-dark` | 白鱼黑水 | dark | 0.62 | 夜水，骨白的鱼，微光字屑 |

- 定义在 `components/theme/themes.ts`（`THEMES`，默认 `koi-light`）。
- 强调色不是彩色，是「墨」本身：浅色主题 accent 近黑，深色主题近白；
  只留一点暖赭（`warm` → `--olivia-gold`）给刻度线、标签与代码。
- Tailwind 的 `light-*` / `dark-*` 两套调色板都在（`tailwind.config.js`），按主题 mode 走。

## 明暗是真的有两套

- `useTheme`（`hooks/useTheme.ts`）按主题把 `.dark` 挂上/摘下，
  `data-theme` / `data-mode` 写在 `<html>` 上，原生控件 `colorScheme` 跟随。
- `ThemePicker` 只有两块磁贴。旧 `olivia.theme.v3` / `olivia.skin` 键在首次加载时迁移：
  旧主题 id 已经不存在，统一落到 `koi-dark`；新键是 `olivia.theme.v4`。
- Electron 侧 `nativeTheme.themeSource` 由 `window.olivia.theme.set(mode)` 跟着走。

## 场景怎么画（KoiScene）

1. 水面：径向底色 + 中心柔光 + 62px 网格（每 5 格一条重刻度）+ 一圈圈椭圆水纹 + 150 粒漂移字屑。
2. 鱼：世界坐标按 12px 网格逐格取样，换算进鱼身坐标系（头 0 尾 1），
   按「体内 / 背鳍 / 胸鳍 / 尾鳍 / 拖曳长鳍」判定，再按离鱼脊的距离分五级明度；
   字块从预渲染图集（40 个字符 × 5 级明度）里 `drawImage` 出来。
3. 游动：李萨如轨迹漂移 + 鱼脊正弦摆动，30fps；`prefers-reduced-motion` 下只画一帧静帧。
4. 切换：`BackgroundLayer` 让旧主题停在最后一帧淡出、新主题淡入（1.5s），像水面换了一次光。

## 可读性：阅读带

主内容区（侧栏右侧）整天都是正文——页头、标题、消息卡片、输入框。
阅读带（`ReadingBand`）从 x=272 起、左缘 176px 羽化，带内字块按
`1 - strength × quiet` 衰减：**strength 0.9**，鱼在带内只剩约一成明度——
一层水下投影，鱼形还在，但压不住字；鱼的本体留给侧栏那一条。
字屑在带内衰减得更狠（×0.8）。消息卡片本身也是纸（`--olivia-card` 0.84 不透明），双保险。

## 水波纹

`RippleLayer` 是一块 `pointer-events: none` 的全屏 canvas：每次 `pointerdown`
在点击处画三圈扩散水纹外加中心高光，1.15s 淡出；没有波纹时停掉 rAF，不空转。
颜色取 `--olivia-accent-rgb`；`prefers-reduced-motion` 下整层关闭。

## 字体：Inter + HarmonyOS Sans SC

全站一套字体组合（`tailwind.config.js` 的 `fontFamily`，声明在 `styles/fonts.css`）：

- 拉丁：Inter 可变字体（100–900，自托管 woff2，Latin / Latin-Ext / 斜体三个文件，按 unicode-range 分片）。
- 汉字：HarmonyOS Sans SC Regular（400）+ Medium（500 与 600 挂同一个文件）——
  700 没有单独文件，按 CSS 匹配落到 Medium；不用浏览器合成加粗，
  Windows 上合成加粗会把 13–15px 的字糊成一团。
- `sans` 与 `serif` 是同一个栈（黑鱼白水这套视觉没有衬线的位置；旧的刻本宋
  `AaGuDianKeBenSong.ttf` 已随视频主题一起下线）。
- 代码等宽：JetBrains Mono / Consolas 打头，汉字回落 HarmonyOS Sans SC。

## AI 输出的整块淡入

流式回合的正文不是打字机：`store.tsx` 的 `createTextCoalescer` 把上游一次几个字的
delta 攒成整句——句末标点一到立刻上屏，等不到标点按 460ms 的节流拍子吐；
工具卡插入与回合收尾前先 flush，保住分片顺序。界面上给流式消息的分片容器挂
`.md-stream`（`base.css`），新出现的段落/列表项/工具卡在挂载时整体淡入
（260ms，上移 5px），已经出场的内容不再动；`prefers-reduced-motion` 下动画关闭。

## 加一套主题

1. 在 `components/theme/themes.ts` 的 `THEMES` 里加一条（`id`/`name`/`caption`/`mode`/`fishAlpha`/`palette`）；
2. 需要专属色板时再动 `tailwind.config.js` 的 light/dark 组；
3. 完事——`ThemePicker` 自动多一块磁贴，变量与场景自动跟上。
   （换几何才是大活：改 `KoiScene` 的 `KOIS` 构图与轮廓函数。）

## 验证

```bash
npm run build:web
npm run shot:theme   # electron 离屏跑 dist 产物，两套主题各截 欢迎页 / 对话页 / 设置页
```

产物在 `docs/screenshots-theme/koi-{light,dark}-{welcome,chat,settings}.png`。
`shot-theme.cjs` 会顺带断言：`data-theme`/`data-mode` 生效、Inter 与
HarmonyOS Sans SC 400/600 都真的加载、标题与正文同一套字体栈、
`.koi-canvas` 不吃鼠标事件、`.pane-veil` / `.hero-plate` 存在。

## 仍然要注意的两个坑

1. **Tailwind 会 purge「拼出来的类名」**：Markdown 的 `md-h${level}` 曾经整条消失，现在用 `data-level` 属性选择器。
2. **纯 CSS 里 `@apply` 任意值不可靠**：只在 CSS 里引用的 `text-[16px]` 之类不保证生成，Markdown 区块改成了原生 CSS。
