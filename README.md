# dsh-rss-news-zhuikan

**想看的网站没有 RSS？把它的列表页地址贴进来，剩下的交给 AI。**

中文 | [English](./README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-rss-news-zhuikan)](https://www.npmjs.com/package/dsh-rss-news-zhuikan)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

`dsh-rss-news-zhuikan`（追看）是 [dsh-rss-news-daily](https://github.com/terry2010/dsh-rss-news-daily) 的伴随插件，补齐一个常见缺口：很多站点——影视资源站、游戏下载页、论坛板块、公告列表——根本不提供 RSS/Atom。追看让你直接订阅这些**普通列表页**：AI 读一遍页面结构，自己学会「标题在哪、链接在哪、发布时间在哪」，之后定时巡检、只推新增。

新出现的条目会自动进入主插件的「全部新闻」列表，和普通 RSS 条目混在一起，不用换地方看。

## 你可以用它做什么

### 订阅没有 RSS 的列表页

贴一个列表页地址，插件先抓页面、提炼结构交给 AI，生成一份提取规则并当场试抽验证。页面上有多个列表区块（比如「最近更新的电影/剧集/动漫」）时，会逐个标出来让你勾选要追哪几个——每个区域都带真实样例条目，点开就能核对抽得对不对。

### 新条目进统一新闻列表

订阅启用后，条目以 `[追]` 前缀的来源出现在主插件「全部新闻」里。因为是用户主动订阅，追看条目默认不参与 AI 评分/翻译/日报/快报管线——也可以在主插件的源设置里逐项打开。

### 关键词命中才推送

可以为每个站（或全局）配关键词。配了词，只有标题/分类/板块命中的新条目才弹桌面通知；某站完全没配适用词时，推该站全部更新。命中记录页能看到每条推送是哪条词、哪个站、什么置信度触发的。

### 站点自己会"康复"

规则因改版失效时，站点标为「疑似改版」，一键重新分析生成新规则、确认后接管。遇到登录墙/挑战页，可用专用浏览器开页登录或过人机校验，登录态之后自动复用。被墙站点勾选「走全局代理」即复用主插件的代理设置，不用单独填地址。

## 使用方式

1. 先安装主插件 `dsh-rss-news-daily`；本插件检测到主插件后自动激活。
2. 在主阅读器的「追看」tab 里粘贴一个列表页地址，点「分析页面」。
3. 等待 AI 出规则（本地模型约 1–3 分钟，有实时进度提示），勾选要订阅的列表区块，确认启用。
4. 站点卡片上可调整抓取间隔、手动抓取、重新分析、配代理或删除；新条目到「全部新闻」查看。

## 数据与隐私

- 站点、提取规则、条目、关键词与命中记录都保存在本机。
- 生成提取规则时会调用你在 dsh 中配置的 AI 模型，发送的是页面结构摘要而非完整页面。
- 登录类站点通过专用浏览器实例完成授权，cookie 留在本机浏览器 profile 里。

## 安装

本插件是伴随插件，请先安装主插件 [dsh-rss-news-daily](https://www.npmjs.com/package/dsh-rss-news-daily)，然后在 dsh 插件管理中安装 `dsh-rss-news-zhuikan`。也可以按运行模式用命令行安装到对应 profile：

```bash
# 桌面版
npm install -g dsh-rss-news-zhuikan   # 或按 dsh 插件安装流程指向本包
```

## 开发

```bash
npm test                 # tsc 构建 + 资源拷贝 + node --test
node scripts/install-to-profile.mjs <profile>   # 装到 ~/.dsh/profiles/<profile>，重启 dsh 生效
```

## 相关项目

- [dsh-rss-news-daily](https://github.com/terry2010/dsh-rss-news-daily) — 主插件：RSS 订阅 + AI 每日精选/快报阅读器
- [dsh-rss-news-flash-kuaixun](https://github.com/terry2010/dsh-rss-news-flash-kuaixun) — 实时财经快讯聚合伴随插件
- [dsh-rss-news-browser-fetch](https://github.com/terry2010/dsh-rss-news-browser-fetch) — 专用浏览器抓取服务（挑战页/登录态/JS 渲染兜底）

## License

Apache-2.0
