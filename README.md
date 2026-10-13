# AI 订阅服务

参考 GETGPT Pro 的页面结构与紫色视觉，使用独立品牌和人工办理流程。由 Vinext、Cloudflare Workers 和 D1 提供前台、订单存储与管理后台。

## 已实现

- 首页、ChatGPT 套餐、Pro、Gemini／Grok／Claude、教程、FAQ、自助排查和订阅指南。
- 下单、收款二维码展示、付款信息提交、凭证查询和订单时间线。
- 后台价格、开售状态、客服和二维码设置、人工收款确认、状态更新与 CSV 导出。
- 按套餐选择人工充值或卡密交付；每单一张，确认到账后自动发放，客户在订单页领取。
- 批量导入卡密、去重、加密库存、库存计数、停用未发卡密、缺货订单补发。
- 服务端定价、订单金额快照、凭证摘要、管理员稳定身份绑定、来源检查、限流和并发版本校验。
- 16 个可配置商品：Plus、Pro 100／200／500、Go、Plus 成品账号、Business、Codex 500／1000／1500 Credits、Gemini／Grok／Claude 及季度、年度和成品账号方案。
- 多套餐购买页、原价与优惠展示、新开通／续费／升级选项、联系区号、全商品小店与库存刷新。
- 29 条 FAQ、17 条排查说明，支持分类和关键词搜索；分步图文教程支持展开、图片放大和配置自己的视频。
- 31 篇独立编写的入门文章、4 页分页、分类标签、搜索、文章目录、相关文章和 RSS。
- 反馈图片分类、放大与翻页，后台发布／撤下真实素材；默认图库为空。
- 联系方式加查询凭证查单、人工找回申请、企业咨询队列、中英文 PDF 收款凭证。
- 卡密人工激活申请及后台处理，网络地区／运营商查询、博客与反馈编辑、商品新增和编辑。

这些内容参照公开页面的信息结构实现；不会获得参考站的私有后台、支付商户、短信验证或上游充值能力。文章为本站自己的说明，商品名称代表可配置目录，实际供应、权益、售价和交付条件需由运营者核实后开售。

客户提交付款信息后只进入“待核实”，必须由运营者在支付宝或微信核实到账。退款状态只记录操作，实际转账退款仍由运营者处理。本版本不接入上游充值 API，不自动登录客户账号，不收集客户密码或会话 Token。

## 卡密自动发货

1. 在后台“卡密库存”按对应套餐导入，每行一张、每批最多 100 张。重复卡密跨套餐去重；列表只显示掩码。
2. 在套餐设置选择“卡密自动发货”，填写兑换入口、有效期、使用范围和售后说明，保存价格及开售状态。
3. 客户付款后，你核实真实到账，在订单处理中选择“已确认收款”。系统原子分配一张库存卡密并将订单完成；订单页展示卡密、复制按钮和购买时的兑换说明。
4. 缺货时订单保留为已收款待补货。导入库存后，点击该订单“补发卡密”。已完成订单重试不会再分配，已发卡密即使退款也不会回库。
5. 若需要由你人工激活，可将商品的“卡密激活方式”设为“提交本站人工激活申请”。客户填写订单凭证、已领卡密和账号邮箱，后台受理并更新结果；此功能不会自动调用上游。

付款核实仍为人工；通过订单页交付卡密，不发送邮件或微信消息，也不替买家在外部平台兑换。下单不预占卡密，待付款订单竞争最后一张库存时可能出现已付款待补货。交付方式与兑换说明保存订单快照，修改商品不影响已有订单。

卡密使用 AES-256-GCM 加密保存。CARD_ENCRYPTION_KEY 必须长期保留，不要直接替换，否则历史卡密将无法解密；CSV 不包含卡密。

## 初次使用

1. 私有站点仅供所有者预览。
2. 打开 /admin，使用 ChatGPT 登录并绑定管理账号。首次绑定需与部署的 ADMIN_BOOTSTRAP_EMAIL 匹配；绑定后按稳定的 Site 用户 ID 授权。
3. 在后台填写客服联系方式、服务时间、自己的收款二维码地址及实际退款说明。
4. 在“商品与卡密”填写实际人民币售价、周期、交付方式和说明，开启相应商品，再开启网站下单。
5. 使用内部小额订单验证完整流程后，再按经营安排开放站点访问。

默认价格为空、收款方式为空、下单关闭。客户资料保存在 D1 数据库，不进入 Git 仓库。二维码可使用可信 HTTPS 图片地址，或将运营者自己的二维码图片放进 public/ 后填写站内路径。

## 本地开发

需要 Node.js 24 及以上。

```text
npm ci
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_parched_pet_avengers.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_marvelous_black_panther.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_lonely_kate_bishop.sql
npm run dev
```

本地 .dev.vars 可参考 .dev.vars.example，仅开发环境使用 seedy@sites.test。访问 /signin-with-chatgpt?return_to=/admin 使用 starter 提供的本地模拟登录；生产身份由 Sites 平台验证。本地数据库与托管数据库相互独立。

## 验证

```text
npm run check
npm run typecheck
npm test
npm run build
```

测试覆盖未授权管理、管理员身份绑定、来源检查、服务端定价、金额快照、错误查询凭证、付款信息不会自动确认收款、非法状态流转、并发修改、卡密去重与竞争最后库存、缺货补发、人工激活幂等、内容发布权限、查询凭证重发、PDF 与 RSS、CSV 公式处理以及独立版本持久化。

## 常用入口

`/plus-price`、`/gptpro`、`/purchase`、`/purchase-go`、`/purchase-gptplus`、`/purchase-gptpro?tier=gptprolite`、`/purchase-upgrade-pro`、`/purchase_credits`、`/gptget`、`/order`、`/codex`、`/xiaodian`、`/team`、`/business-recharge`、`/ip`、`/feedback`、`/guide`、`/faq`、`/help`、`/blog`、`/chatgpt-plus`、`/chatgpt-pro`、`/admin`。RSS 位于 `/blog/rss.xml`，站点地图位于 `/sitemap.xml`。

联系方式查询仍需要查询凭证，避免仅凭手机号泄露卡密。遗失凭证的客户提交人工找回申请后，运营者需在原沟通渠道核实身份，再在后台重发；旧凭证会失效。企业申请只进入后台队列，不会自动发送邮件或微信。

网络工具需客户明确同意才将输入的公网 IP 提交给 `ipwho.is`；仅展示地区、运营商及 ASN，不生成代理风险分或账号质量判断。教程视频、客服二维码和反馈图片通过经营设置与内容后台配置。

## 部署与源码

.openai/hosting.json 记录同一个 Sites 项目身份和 D1 绑定，继续编辑时请保留。运行时 ADMIN_BOOTSTRAP_EMAIL 和 CARD_ENCRYPTION_KEY 在 Sites 环境变量中配置，不写入源码。使用 Sites 技能维护数据库迁移、构建、推送和发布；不要重复注册该项目。

如要在自己的服务器独立运行，standalone/ 提供不依赖 Sites 登录的 Node.js + SQLite 版本；按其中 README 配置强管理密码、HTTPS 和持久化磁盘。它与 Sites 使用不同的数据存储，不能互相读取订单。

前台与后台仍需结合运营者实际套餐、充值方法、收款和售后规则调整。本站没有复制参考站的客户评价、用户规模、成功率或分钟级到账承诺。
