# 部署、监控与备份恢复

适用范围：单机容器部署、受控团队试用。这里提供可以执行的操作流程，不代表已替你开通公网服务、定时备份或告警收件人。项目仍为 pre-alpha；上线前同时检查 [安全部署清单](./SECURITY_DEPLOYMENT.md)。

## 1. 部署真实服务

需要 Docker Engine / Docker Desktop 和 Compose v2、独立 PostgreSQL 17、带 TLS 的 Redis。数据库与 Redis 只对应用私网开放。生产模板不创建或覆盖数据库，不包含示例管理员与默认密码。

由部署平台的 Secret Manager（密钥保险箱）向当前操作环境注入：

| 环境变量                       | 用途                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                 | 专用 PostgreSQL 连接地址和账户；模板强制验证 TLS 证书                                      |
| `REDIS_URL`                    | 使用 `rediss://` 的专用队列连接，配置服务端认证和访问控制                                  |
| `MODEL_ENCRYPTION_KEY`         | API 与 Worker 共用的 32 字节 Base64 加密密钥；与数据库备份分开保管，丢失后无法解密模型密钥 |
| `METRICS_AUTH_TOKEN`           | 独立的 32–512 字符监控凭证；不要使用用户登录 Token                                         |
| `WEB_ORIGIN`                   | 实际访问的完整 HTTPS 来源，例如 `https://eval.example.com`                                 |
| `MODEL_PROVIDER_ALLOWED_HOSTS` | 建议设置精确的模型服务域名白名单                                                           |

不要把实际密码粘进命令历史、Git、截图或工单。以下命令在仓库根目录执行，凭证从环境读取：

```sh
docker compose -f deploy/compose.yml config --quiet
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml run --rm api node node_modules/@ai-chat-eval/db/dist/migrate.js
```

第一次安装时，另外通过安全环境注入 `AUTH_BOOTSTRAP_EMAIL` 和 `AUTH_BOOTSTRAP_PASSWORD`（15–128 字符），再运行一次：

```sh
docker compose -f deploy/compose.yml run --rm -e AUTH_BOOTSTRAP_EMAIL -e AUTH_BOOTSTRAP_PASSWORD api node dist/bootstrap-admin.js
docker compose -f deploy/compose.yml up -d --wait
docker compose -f deploy/compose.yml ps
```

随后从环境移除初始化密码。模板开启 `AUTH_MODE=team`，网页仅绑定宿主机 `127.0.0.1:8080`，API 和 Worker 不发布宿主机端口。在宿主机 HTTPS 反向代理上将域名转发到该地址，证书、访问日志、网关限流由部署者配置。不要通过公网明文 HTTP 登录。

容器默认非 root（非管理员）、只读根文件系统、临时目录、资源上限和日志轮转。使用自签名基础设施证书时，需要额外挂载受信 CA 并设置 `NODE_EXTRA_CA_CERTS`，不能关闭证书校验。`deploy/compose.acceptance.yml` 只供 CI 使用，里面的测试密码和一天有效的证书不是生产配置。

当前模板会覆盖外来 `X-Forwarded-For`，防止伪造来源；经过外层代理后应用可能把请求归到同一个代理地址。外层网关需按真实客户端限流；如需透传真实 IP，应明确配置可信代理网段，不能直接信任公网传来的请求头。多副本的共享限流、自动伸缩和高可用仍不在本模板范围。

升级前先备份并在独立环境验证迁移。数据库迁移不保证可以自动降级，不能假定换回旧镜像就能回滚数据结构。

## 2. 监控与告警

API `/metrics` 与 Worker `/metrics` 要求 `Authorization: Bearer <METRICS_AUTH_TOKEN>`。网页代理拒绝公开转发该入口。监控系统必须处于可访问应用容器的私网；示例地址 `api:4000`、`worker:4101` 只有在同一容器网络内才能解析。

将 `deploy/monitoring/prometheus.yml` 和 `alerts.yml` 加入现有 Prometheus（指标采集服务），把监控凭证以只读 Secret 文件挂载到 `/run/secrets/prs_metrics_token`。这不是网页登录凭证，不应放到前端。

已有指标与规则覆盖：

- API / Worker 存活及数据库、Redis 就绪状态；
- 排队和执行中评测数量、最老任务等待时间；
- 持久化派发失败、过去 24 小时的评测失败数量；
- HTTP 401/403、429、5xx，以及接近预估预算上限的实验。

指标不带 Prompt、模型密钥、邮箱、项目 ID 或原始 URL。数据库采集采用单次共享查询和短缓存；超时显示依赖不可用，不会把缺失的任务数伪装为零。费用告警基于平台预估，不是供应商账单保证。

**告警规则触发不等于有人收到通知。** 必须在 Prometheus 配置 Alertmanager（通知分发服务），设置邮件/聊天工具接收人、值班安排，并人为停止测试 Worker 验证完整通知链路。仓库的规则测试只验证规则触发，不会替用户发送邮件。当前没有提供 Grafana 大屏或完整日志平台。

## 3. 数据库备份

在受信备份主机安装 Node.js、项目依赖和 PostgreSQL 17 客户端工具（`pg_dump`、`pg_restore`、`psql`）。客户端必须兼容源数据库版本。设置独立的 `BACKUP_DATABASE_URL`；远程地址强制 `verify-full`，自签名 CA 使用 `BACKUP_SSL_ROOT_CERT` 指向证书文件。脚本不会自动读取开发 `.env`，避免误选数据库。

```sh
pnpm db:backup /secure/prs-backups
```

每次创建独立的时间戳目录，包含 `database.dump` 和带 SHA-256 校验的 `manifest.json`。备份失败不会发布完整清单；不得把 `.partial` 文件当成可用备份。可用 `PG_DUMP_BIN`、`PG_RESTORE_BIN`、`PSQL_BIN` 指定工具路径。

备份包含对话、Prompt、账号密码哈希及加密后的模型凭证，**不是已脱敏数据**。Unix 文件权限收紧只是第一层保护；Windows 需另外设置目录 ACL。应使用加密磁盘/对象存储，限制访问并保存异地副本。加密密钥独立备份，切勿上传 GitHub Actions artifact 或提交 Git。

部署者需要通过自己的定时任务/备份服务执行该命令，监测退出码、最后成功时间、磁盘容量和异地复制结果，并制定保留与删除策略。本工具不会擅自创建计划任务、删除旧备份，也不提供 PostgreSQL WAL 持续归档或时间点恢复。备份频率决定可能丢失的数据窗口，不能宣称零数据丢失。

## 4. 隔离恢复演练

仅恢复你信任的备份：校验和能发现文件损坏，不代表备份内容可信。不要使用超级管理员账户恢复陌生人提供的数据库归档。

1. 准备独立、空白、本机 PostgreSQL 数据库，名称以 `prs_restore_` 开头。不要连接正在运行的生产库。
2. 注入该库的 `RESTORE_DATABASE_URL`，以及原始 `MODEL_ENCRYPTION_KEY`；项目依赖需已安装、`pnpm packages:build` 已完成。
3. 执行以下命令，使用备份时返回的具体目录：

```sh
pnpm db:restore-check /secure/prs-backups/具体备份目录
```

脚本首先校验大小和哈希，拒绝远程目标、不合命名规则的目标和非空数据库，随后事务恢复。恢复后会：

- 删除恢复出来的旧登录会话，要求重新登录；
- 将未完成任务标记为 `RESTORE_REVIEW_REQUIRED` 并阻止旧待派发任务自动重启，避免重复调用收费模型；
- 验证保存的模型凭证能够由原密钥解密，但不输出密钥明文；
- 生成恢复报告，列出项目、版本、输出、评分和报告数量。

恢复或解密校验失败时，命令返回非零；目标库可能已经存在恢复数据，不能当成成功上线，也不要反复覆盖。查明原因后，另建空白隔离库重新演练。

正式切换由部署者执行：停止旧 API/Worker 的写入，做最终备份，在隔离库检查关键业务数据，再配置新的数据库连接和**新的独立 Redis 队列**后启动。不要给新库复用旧 Redis 队列，不要让两个环境同时处理同一批任务。原库保留回退窗口；待复核任务由负责人决定是否重新发起。工具本身不会改生产连接或切换流量。

## 5. 验收范围

`pnpm test:operations` 检查恢复目标限制与 TLS 安全配置。`pnpm test:system` 使用独立 PostgreSQL / Redis 执行真实服务链路，并在停止写入后备份、恢复、比较 14 张表的数据指纹，检查模型密钥解密、损坏备份拒绝、非空库拒绝、旧会话失效、未完成任务隔离和源库未被更改。

`node scripts/test-deployment.mjs` 需要 Docker 和 OpenSSL；会构建三个实际镜像，以生产模式连接带证书验证的 PostgreSQL / Redis，验证网页静态资源、登录、项目创建、Python 诊断、私有指标、非管理员运行及重启后数据保留，并用 `promtool` 检查监控配置及告警规则。它只创建随机命名的验收容器项目，结束时清理该项目；不要把验收配置用于生产。

GitHub CI 运行这两条验收链路，结果见 Actions。它们不等于真实浏览器全流程、真实付费模型、公开域名 HTTPS、告警收件人、异地自动备份或生产规模容量验收；这些仍必须在实际部署环境完成。
