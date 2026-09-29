# XCPC 训练台

一个面向算法竞赛选手（XCPC / ICPC / CCPC / Codeforces / AtCoder / 洛谷）的**本地训练辅助软件**：把多平台训练数据整理成可信的生涯档案，按目标 Rating 生成分阶段训练计划，支持虚拟参赛与赛后复盘、ICPC/CCPC 补题追踪。所有数据保存在本地，零第三方依赖，不需要注册任何账号。

> 设计上借鉴了两个优秀开源项目的思路（详见文末「参考与致谢」）：
> **OJ Insight**
>
>  —— 跨平台训练数据面板，强调「可验证的逐题记录、公开汇总、缺失数据三者分开，不用不可比的口径拼出看起来完整的统计」；
> **ACM Tracker**
>
>  —— 按目标 Rating 生成训练计划 + 虚拟参赛复盘，强调「告诉你下一步练什么」。

## 运行方式

环境要求：**Windows / macOS / Linux**，安装 **Node.js 22.5 或更高**（[https://nodejs.org/](https://nodejs.org/) ，本程序使用 Node 内置的 SQLite，无需 `npm install`）。

### 方式一：命令行启动



```
cd xcpc-trainer

node --disable-warning=ExperimentalWarning --experimental-sqlite server.js
```

浏览器打开 [http://127.0.0.1:5173/](http://127.0.0.1:5173/) 即可。按 `Ctrl+C` 停止。

### 方式二：一键脚本



* Windows：双击 `start.cmd`；

* macOS / Linux：执行 `./start.sh`。

> 如果端口 5173 被占用，设置环境变量 
>
> `PORT`
>
>  换端口，例如 PowerShell：
>
> `$env:PORT='5199'; node ... server.js`
>
> 。

### 其他脚本



```
npm run sync    # 手动刷新 Codeforces + AtCoder 题库缓存

npm run train   # 采集 Codeforces 历史比赛并训练「能否做出」推题模型（可选，约十几分钟）

npm run smoke   # 冒烟测试
```

## 快速开始



1. 打开「设置」，填写想同步的 OJ 账号并保存（Codeforces Handle 不需要 Cookie；AtCoder 用户名直接可用；洛谷做题记录需要 Cookie，不填也能导入题库）。

2. 打开「设置 → 数据同步」，对每个账号点「同步最新」（首次可点「重新同步全部」）。

3. 回到「总览」查看生涯统计与活动砖；到「训练计划」设定目标 Rating 与每周题量，生成计划。

程序启动时会先显示本地缓存，再在后台同步已配置的平台。可随时在「设置」里清空单站或全部数据（保留账号设置）。

## 功能

### 总览（生涯与区间统计）



* **Solved**：各平台内至少 AC 一次的不同题数之和，不跨 OJ 去重；**AC Submissions**：可验证的 Accepted 提交数；**Active Days**、最长 / 当前连续活跃天数、单日峰值。

* **活动砖**：按自然年或最近 365 天查看，四种口径可切换（First AC / Unique AC / AC Submissions / 平台原始 Activity），支持导出 PNG / SVG。

* **Rating 总览**：当前 Rating、历史最高、最近变化与比赛曲线，点击可跳转原站对应比赛。

* **难度足迹**：保留各平台自己的难度体系（CF Rating 分段 / AtCoder Difficulty / 洛谷官方难度 / LeetCode E/M/H），不跨平台强行换算，无可靠难度的题目归入「未评级」。

* **近期记录**：最近 AC 列表，点击直达题面。

* **数据源状态**：明确区分逐题记录、日期汇总、缺失数据；同步失败只更新错误状态，缓存数据仍可查看。

### 训练计划



* **能力画像（八方向）**：把 CF 官方 tag 归成 8 个知识方向（基础与模拟、数据结构、图论与树、动态规划、数学、字符串、搜索与构造、贪心与思维）。每个方向用**75 分位**代表水平（不被偶然做对的一道难题拉高），按样本量给置信度，未做过的专题单独标出（盲区最该补），并计算 0\~100 的弱项指数。

* **分阶段爬坡**：从当前 Rating 到目标 Rating，每隔约 200 分切一个阶段，练习区间 = 阶段目标 −250 \~ +150（公认效率较高的范围）。

* **选题三规则**：优先命中弱项专题；优先被大量人做过的题；难度取区间中上段；单个标签占比上限（默认 40%）防偏科；全计划去重；已做题自动排除。

* **混排**：可选混入 AtCoder（Kenkoooo 难度 +200 折算）与洛谷题，AtCoder / 洛谷每源每天最多一题，CF 每天最多 ceil (周题量 / 3)，同一天不会出现两道同平台题。

* **日程排程**：勾选每周固定休息日；点日历任意一天可标记「没空」并写原因，题目自动顺延，总题量不变；第一周按剩余天数折算。

* **题量估算**：经验系数「每提升 100 分约 60 题」，按每周题量换算成周数。

### 题库与题单



* 本地题库可筛：关键词（题号 / 标题）、难度区间、算法标签、来源、只看未做；排序按难度 / 通过人数 / 最新比赛；「随机来一道」。

* **我的题单**：粘贴一段带题号或链接的文本即成题单（识别 CF / AtCoder / 洛谷三家），可逐题勾进度、追加、移除、复制未做完的。

* 做过的题自动标为已完成并压暗；题库缓存 7 天更新一次，页面不联网。

### 比赛与虚拟参赛



* **比赛日历**：未来 14 天已公布场次（Codeforces / AtCoder），换算成本机时区，并按当前 Rating 标注「正合适 / 偏简单 / 偏难」；AtCoder 只列计分场次并显示计分区间。

* **虚拟参赛（VP）**：从已结束的比赛里挑适合你的场次，本地倒计时、可暂停 / 继续；做题仍在原 OJ 提交。

* **赛后复盘**：按「比赛 + 时间窗口 + 提交记录」计算，不依赖你是否在平台上注册虚拟赛；无法获取的错误提交不会被推断为 WA。可导出复盘 ZIP（00-START-HERE / 01-CONTEST / 02-PROBLEMS / 03-SUBMISSIONS，可绑定本地代码、写 Markdown 笔记）。

### ICPC / CCPC 补题追踪



* 内置 ICPC / CCPC / 邀请赛 / 省赛参考目录（按年份、系列、赛站、进度筛选；站点 / 年份为公开信息，题数为参考值）。

* 逐题记录 todo /ac/tried /skipped，可粘贴链接（CF / AtCoder / 洛谷 / 裸题号）自动解析并补全标题难度。

* 完成状态来自本地记录（可自动匹配洛谷已做或手动标记），不会把无法获取的提交推断为 AC。

### 设置



* 账号凭据（CF Handle、AtCoder 用户名、洛谷 UID + 可选 Cookie；Cookie 只存本地数据库）。

* 数据同步（同步最新 / 重新同步全部 / 清空单站 / 清空所有）。

* 洛谷题库按难度档导入（等距抽页抓取，单档增量替换，不互相覆盖）。

* **训练推荐模型（可选）**：采集 Codeforces 历史比赛，训练「给定赛前 Rating 与题目条件能否做出」的逻辑回归；按比赛时间切分留出集，只有 AUC ≥ 0.75 且明显优于基线时才启用，否则继续用内置规则并说明原因。

* 四套主题（暗色 / 亮色 / 灰色 / 护眼），保存在本地。

## 统计口径（不牺牲准确性）



* Career 始终基于本地已知全部历史；当前范围只统计选中自然年或最近 365 天。

* 带准确时间的记录按所选时区重新计算日期；上游只提供 YYYY-MM-DD 的记录保留来源日期，不伪造提交时刻。

* Rating 和难度不跨平台强行换算；缺少逐题历史时不伪造提交；同步失败只更新错误状态。

* 同一平台在不同时间可取得的数据粒度可能不同（上游接口可能调整），界面会明确显示当前边界。

## 技术结构

零第三方 npm 依赖：Node 内置 `node:sqlite` 做数据层，原生 HTML/CSS/JS 前端（无构建），单 `server.js` HTTP 服务。



```
server.js                 HTTP 服务与全部路由（REST API + 静态资源 + 后台任务执行器）

lib/db.js                 SQLite 数据层（WAL 模式，幂等迁移）

lib/cf.js                 Codeforces API 客户端（全局 2s 串行限速，匿名 standings）

lib/ac.js                 AtCoder / Kenkoooo 客户端（题库缓存、提交游标增量、官方 rating 端点）

lib/luogu.js              洛谷客户端（题库按档导入、做题记录需 Cookie）

lib/knowledge.js          tag → 知识方向、75 分位、置信度、难度折算

lib/plan.js               训练计划与日程排程引擎

lib/stats.js              生涯统计与活动砖口径

lib/contests.js           比赛日历、虚拟参赛、赛后复盘

lib/icpc.js               ICPC/CCPC 目录与补题追踪

lib/zip.js                最小 ZIP 写入器（复盘包导出）

lib/model.js              可选逻辑回归推题模型（留出集检验后才启用）

scripts/sync-problems.js  刷新题库

scripts/train-model.js    采集比赛数据训练推题模型

scripts/smoke.mjs         端到端冒烟测试

public/                   六个页面（总览 / 训练计划 / 题库 / 比赛与虚拟赛 / ICPC追踪 / 设置）

data/xcpc.db              你的所有数据（复制即备份，删除可重建）
```

接口一览（节选）：`/api/health`、`/api/settings`、`/api/sync`（异步任务）、`/api/stats`、`/api/activity`、`/api/rating`、`/api/capability`、`/api/plan/generate`、`/api/contests`、`/api/virtual/*`、`/api/sets/*`（ICPC）、`/api/lists`、`/api/problems`、`/api/luogu/*`、`/api/model/*`。

## 数据位置与备份



* 数据目录：`<项目根目录>/data`，主文件为 `data/xcpc.db`。

* **备份 / 迁移**：先退出程序，再复制整个 `data` 目录即可。程序重启会自动兼容旧库结构。

* Cookie / Session 等价于登录凭据：导出数据库或日志时注意脱敏（运行日志会对 Secret 类字段脱敏）。

## 已知限制



* 洛谷做题记录同步需要登录 Cookie；不填 Cookie 只能导入题库。

* 虚拟参赛只做本地计时与复盘，不会替你操作 OJ 账号。

* 复盘「难度加权分」是各题难度之和，用于横向比较自己的成长，不是平台官方 Rating。

* 比赛日历只显示未来 14 天、且官方已公布的场次。

* 洛谷不提供逐题难度，档位分数为估算值，界面角标会显示真实档位。

* 推题模型仅在通过留出集检验后启用；默认走内置规则。

## 参考与致谢



* 统计口径与数据边界理念参考 [OJ Insight](https://github.com/Whalica/OJ_Insight)（MIT 协议）—— 多平台训练数据面板的思路；本项目未使用其代码。

* 训练计划与虚拟参赛复盘的产品形态参考 [ACM Tracker](https://github.com/DB-SLSQ/Acm-Tracker)（README 公开信息）——「告诉你下一步练什么」的思路。

* 题目难度数据来自 [Kenkoooo / AtCoder Problems](https://kenkoooo.com/atcoder/) 公开接口与 AtCoder 官方页面；Codeforces 数据来自官方 API（请求遵守 2 秒间隔与匿名限制）。