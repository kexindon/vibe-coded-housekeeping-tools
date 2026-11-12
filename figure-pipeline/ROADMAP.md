# Figure Pipeline 开发步骤

联动 Adobe Illustrator 和 Google Docs：自动化 figure legend、文中 figure 编号、figure 排版，并按期刊要求生成投稿文件夹。

## 核心思路

Illustrator 和 Google Docs 不直接通信，两边都读写 Google Drive 上的同一份清单 `figures.json`。

```
Illustrator 脚本 ──导出图+写清单──▶ Google Drive ◀──读清单+改文档── Google Docs 插件
                                  (figures.json)
                                        │
                                        ▼
                               投稿打包器 + 期刊配置文件
```

每个 figure 有一个永久 ID（如 `fig:mito-imaging`）。编号（Figure 1、Figure S1）不存储，每次刷新时按正文首次引用顺序计算。

## 计划的目录结构

```
figure-pipeline/
├── ROADMAP.md            本文件
├── docs-addon/           Google Docs 插件（Apps Script）
├── illustrator/          Illustrator 导出和预检脚本
├── packager/             投稿打包器
├── journal-profiles/     期刊配置（每个期刊一份 JSON）
└── schema/               figures.json 的格式定义和示例
```

子目录在做到对应步骤时再建。

## 第 0 步：先定下来的事

- [ ] 第一批目标期刊（2–3 个）
- [ ] 文件约定：一个 figure 一个 `.ai`，还是一个 `.ai` 里多个 artboard
- [ ] panel 标记约定：图层名还是文字标签（A、B、C）
- [ ] Drive 上的项目文件夹结构
- [ ] `figures.json` 的字段：ID、标题、主图/补充图、panel 列表、源文件、导出文件、更新时间

## 第 1 步：Google Docs 插件

不依赖 Adobe，图先手动导出放进 Drive。

- [ ] 侧边栏：列出清单里的 figure，可新建、改标题、切换主图/补充图
- [ ] 在光标处插入 figure 引用标记（可带 panel，如 1A、1B–D）
- [ ] "刷新编号"：按首次引用顺序重排，主图和补充图分开计数
- [ ] 生成和更新 legend 区块：标题加每个 panel 一段，已写的文字不覆盖
- [ ] 插入和替换 figure 预览图（文中或文末）
- [ ] 检查：未被引用的图、引用了不存在的 panel、legend 缺 panel
- [ ] 容错：标记被合作者手动改坏或处于建议模式时给出提示

## 第 2 步：Illustrator 导出和预检

- [ ] 技术选型：确认 ExtendScript、CEP、UXP 在当前 Illustrator 版本上的支持情况
- [ ] 读取文档：artboard 尺寸、panel 标签、字体字号、线宽、色彩模式、嵌入位图分辨率
- [ ] 按期刊配置预检并列出不合规项
- [ ] 导出投稿格式（PDF/TIFF/EPS）和 PNG 预览
- [ ] 上传到 Drive 并更新 `figures.json`（panel 列表自动同步）

## 第 3 步：期刊配置

- [ ] 配置格式：图宽（单栏/双栏）、字体和字号范围、最小线宽、文件格式、分辨率、色彩模式
- [ ] 引用和命名格式：`Fig. 1a` / `Figure 1A`、`Figure S1` / `Extended Data Fig. 1`、文件命名规则
- [ ] 限制：主图数量上限、legend 字数上限
- [ ] 写出第一批目标期刊的配置，并注明核对日期和来源链接

## 第 4 步：投稿打包器

- [ ] 按期刊配置重命名并收集 figure 文件
- [ ] 导出正文和单独的 legend 文档
- [ ] 生成投稿文件夹：

```
submission_<期刊>_<日期>/
├── Manuscript.docx
├── Figures/
├── Supplementary/
├── Figure_Legends.docx
├── Source_Data/
└── preflight_report.md
```

- [ ] 生成合规报告：通过项、需要手动处理的项

## 第 5 步：可选增强

- [ ] AI 起草 legend 文字（根据 panel 标签和 Methods），n 值和统计方法留空待确认
- [ ] 换期刊时一键切换配置并重新预检
- [ ] Source data 文件和 panel 的对应关系
- [ ] 表格（Table）和补充表格的编号

## 已知难点

- Google Docs 没有原生交叉引用，标记靠 named range 或文本标记实现，容易被手动编辑破坏。
- Legend 的科学内容（n 值、统计检验、误差线含义）不能自动生成，只能起草后人工确认。
- Panel 识别依赖命名约定，旧的 `.ai` 文件需要先整理。
- 期刊要求会变，配置文件需要人工维护。
