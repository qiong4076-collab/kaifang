# AI 订阅服务

参考 GETGPT Pro 的页面结构与紫色视觉，使用独立品牌和人工办理流程。由 Vinext、Cloudflare Workers 和 D1 提供前台、订单存储与管理后台。

## 已实现

- 首页、ChatGPT 套餐、Pro、Gemini／Grok／Claude、教程、FAQ、自助排查和订阅指南。
- 下单、收款二维码展示、付款信息提交、凭证查询和订单时间线。
- 后台价格、开售状态、客服和二维码设置、人工收款确认、状态更新与 CSV 导出。
- 服务端定价、订单金额快照、凭证摘要、管理员稳定身份绑定、来源检查、限流和并发版本校验。

客户提交付款信息后只进入“待核实”，必须由运营者在支付宝或微信核实到账。退款状态只记录操作，实际转账退款仍由运营者处理。本版本不接入上游充值 API，不自动登录客户账号，不收集客户密码或会话 Token。

## 初次使用

1. 私有站点仅供所有者预览。
2. 打开 /admin，使用 ChatGPT 登录并绑定管理账号。首次绑定需与部署的 ADMIN_BOOTSTRAP_EMAIL 匹配；绑定后按稳定的 Site 用户 ID 授权。
3. 在后台填写客服联系方式、服务时间、自己的收款二维码地址及实际退款说明。
4. 填写实际人民币月费，开启相应商品，再开启网站下单。
5. 使用内部小额订单验证完整流程后，再按经营安排开放站点访问。

默认价格为空、收款方式为空、下单关闭。客户资料保存在 D1 数据库，不进入 Git 仓库。二维码可使用可信 HTTPS 图片地址，或将运营者自己的二维码图片放进 public/ 后填写站内路径。

## 本地开发

需要 Node.js 24 及以上。

```text
npm ci
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_parched_pet_avengers.sql
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

测试覆盖未授权管理、管理员身份绑定、来源检查、服务端定价、金额快照、错误查询凭证、付款信息不会自动确认收款、非法状态流转、并发修改及 CSV 公式处理。

## 部署与源码

.openai/hosting.json 记录同一个 Sites 项目身份和 D1 绑定，继续编辑时请保留。运行时 ADMIN_BOOTSTRAP_EMAIL 在 Sites 环境变量中配置，不写入源码。使用 Sites 技能维护数据库迁移、构建、推送和发布；不要重复注册该项目。

如要在自己的服务器独立运行，standalone/ 提供不依赖 Sites 登录的 Node.js + SQLite 版本；按其中 README 配置强管理密码、HTTPS 和持久化磁盘。它与 Sites 使用不同的数据存储，不能互相读取订单。

前台与后台仍需结合运营者实际套餐、充值方法、收款和售后规则调整。本站没有复制参考站的客户评价、用户规模、成功率或分钟级到账承诺。
