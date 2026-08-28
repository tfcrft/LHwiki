# 本地 API 集成测试

LHwiki 的 API 集成测试完全在本机运行，不读取 CloudBase 密钥、不连接生产数据库，也不使用真实学号。测试使用虚构的 `2099` fixture 账号、测试专用内存 Store，以及监听在 `127.0.0.1` 随机端口上的真实 Node HTTP 服务。

## 运行

在本目录执行：

```bash
pnpm test
```

不需要设置 `TCB_ENV`、`CLOUDBASE_APIKEY`、生产 `SESSION_SECRET` 或站点 URL。生产环境巡检脚本 `pnpm smoke:functional` 和 `pnpm stability:check` 不属于默认测试，不会由上述命令访问。

只运行 API 集成测试时可执行：

```bash
node --test test/api-app.test.js test/memory-store.test.js test/api-integration.test.js
```

## 结构

- `cloudbase/functions/lhwiki-api/api-app.cjs`：可注入 Store 与配置的真实 API handler。
- `cloudbase/functions/lhwiki-api/server.js`：生产 PostgreSQL、环境变量与监听端口的装配入口。
- `test/helpers/memory-store.cjs`：仅供测试使用的内存 Store，实现与生产 Store 相同的七个操作，并支持条件更新、草稿唯一键和单次故障注入。
- `test/api-integration.test.js`：通过本地 HTTP 请求验证跨接口流程。

每个测试都会创建独立的 Store、app、缓存、限流状态和随机端口，并在结束后关闭服务，测试之间不共享账号或数据。

## 已覆盖流程

- 登录、签名 Cookie、会话恢复、篡改拒绝、退出和同源写请求检查。
- 普通学生登录不产生持久化用户记录。
- 草稿创建、列表、更新、删除、所有权隐藏和乐观版本冲突。
- 新草稿投稿、审核退修、投稿草稿重投、批准发布、审核事件和贡献者批准。
- 未登录、学生、审核员、管理员的关键权限矩阵。
- 管理员校订不改变投稿归属，受保护管理员不可降权，锁定账号不可自助提权。
- 教师补充投稿、审核队列匿名化和批准。
- 维护模式保持公开健康检查，同时在访问 Store 前阻断私有接口。
- 数据库 503 与未知异常的状态码、稳定错误文案、诊断码和敏感信息脱敏。
- 内存 Store 的 CRUD、过滤、upsert、条件更新、唯一约束、深拷贝隔离与故障注入。

## 仍未覆盖的风险

- 内存 Store 不验证 PostgreSQL/PostgREST 的数据类型、约束、RLS、索引、排序规则和 HTTP 编码；这些仍由迁移审查、adapter 单元测试和受控生产巡检负责。
- 审核批准等多次写入目前沿用现有非事务实现；本地测试能验证成功路径和单次故障响应，但不能证明多写操作在真实数据库中的原子性。
- 进程内限流测试不代表多实例 CloudBase 的全局限流效果。
- 测试客户端手工回传 `Secure` Cookie，不能替代真实浏览器对 Cookie 策略的兼容性验证。
- 本地随机端口测试不覆盖 CloudBase 网关、域名、TLS、代理头和部署配置。
