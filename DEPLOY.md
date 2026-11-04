# 内网部署与二次开发指南

适用版本：v1.32.0　更新日期：2026-11-03

这个包是完整的源码 + 测试 + 文档，不含 `node_modules`，也不含运行数据。放到内网后解压、装 Node、`node server.js` 就能跑。

---

## 1. 包里有什么

```
pmo-program-console-1.32.0/
├── server.js              # HTTP 服务、SQLite、权限、审核流、报表生成
├── public/                # 前端（无构建）
│   ├── index.html
│   ├── app.css
│   └── app.js
├── tests/api.test.js      # 47 项接口集成测试
├── scripts/ui-smoke.mjs   # 浏览器冒烟（CDP，零依赖）
├── scripts/load-test.mjs  # 轻量并发压测
├── scripts/security-check.mjs # 安全基线检查
├── scripts/backup.js      # 在线备份（VACUUM INTO，不需要停服务）
├── deploy/
│   ├── pmo.service        # systemd 示例
│   └── nginx.conf         # Nginx 反代 + HTTPS 示例
├── docs/                  # 架构评估、界面截图
├── Dockerfile
├── docker-compose.yml
├── package.json
├── start.sh
├── README.md
└── DEPLOY.md              # 本文件
```

没有 `data/` 目录。第一次启动会自动创建 `data/pmo.db` 并写入演示数据。

---

## 2. 运行环境

- **Node.js 22.5 或更高版本**（用到内置 `node:sqlite`）。
- **不需要 `npm install`**，没有任何第三方依赖。
- 支持 Windows / Linux / macOS。

检查版本：

```bash
node --version        # 需要 v22.5.0 以上
node -e "require('node:sqlite'); console.log('sqlite ok')"
```

### 内网离线安装 Node

在一台能上网的机器上下载对应系统的 Node 22 LTS 安装包（Windows 的 `.msi`，Linux 的 `.tar.xz`，macOS 的 `.pkg`），拷进内网安装。装完把 `node` 加入 PATH 即可。

Linux 免安装方式：

```bash
tar -xJf node-v22.x-linux-x64.tar.xz -C /opt
ln -s /opt/node-v22.x-linux-x64/bin/node /usr/local/bin/node
```

---

## 3. 快速启动

```bash
# 只允许本机访问
node server.js

# 允许局域网访问（没有 HTTPS，建议只在前置反代后使用）
PMO_HOST=0.0.0.0 PMO_PORT=5177 node server.js
```

Windows PowerShell：

```powershell
$env:PMO_HOST="0.0.0.0"; $env:PMO_PORT="5177"; node server.js
```

打开 `http://127.0.0.1:5177`。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PMO_PORT` | `5177` | 监听端口 |
| `PMO_HOST` | `127.0.0.1` | 监听地址；放反代后保持 127.0.0.1 |
| `PMO_DB` | `data/pmo.db` | 数据库路径，可以是绝对路径 |

首次启动会创建演示账号：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `pmo` | `pmo123456` | PMO 管理员 |
| `zhangwei` 等 9 个 | `pm123456` | 乙方项目经理 |
| `hejing` 等 9 个 | `pm123456` | 甲方项目经理 |

**上线前必须改密码。**

项目经理分甲方 / 乙方：乙方负责周报、计划等维护，甲方只读并可留言；具体由项目台账里的两个项目经理字段决定。甲方账号为 `hejing` / `maxiao` / `gaoxiang` / `xulei` / `zhoumin` / `lintao` / `jiangnan` / `luocheng` / `tangyue`。

---

## 4. 数据、备份与恢复

### 数据在哪

默认 `data/pmo.db`，同目录还可能有 `-wal`、`-shm` 文件，这是 SQLite 的正常 WAL 模式，不要单独删。

### 在线备份

```bash
npm run backup
# 或
node scripts/backup.js
```

每次会生成三个文件：

- `pmo-<时间>.db`：`VACUUM INTO` 一致性快照，不用停服务。
- `pmo-<时间>.ai-key`：AI 配置解密密钥，恢复时一起放回 `data/.ai-key`。
- `pmo-<时间>.json`：SHA-256、大小、来源和时间。

默认保留 30 天，可用 `PMO_BACKUP_KEEP_DAYS` 调整。备份目录权限 700，文件 600。

指定路径：

```bash
PMO_DB=/var/lib/pmo/pmo.db PMO_BACKUP_DIR=/backup/pmo node scripts/backup.js
```

macOS 可安装每日 02:00 的 LaunchAgent：

```bash
./scripts/install-daily-backup.sh
launchctl print "gui/$(id -u)/com.pmo.backup"
```

Linux 可加 cron：

```cron
0 2 * * * cd /opt/pmo && PMO_BACKUP_DIR=/backup/pmo /usr/bin/node scripts/backup.js >> /opt/pmo/backups/backup.log 2>&1
```

备份文件要拷到另一台机器或对象存储，别只留在本机；只在本机 `backups/` 只能防误删，防不了磁盘损坏。

校验备份（只读，不改生产库）：

```bash
node scripts/verify-backup.js backups/pmo-<时间>.db
```

### 恢复

1. 停服务。
2. 把备份文件放回 `data/pmo.db`（删除旧的 `-wal`、`-shm`）。
3. 启动服务。

### 导出 / 导入 JSON

「管理维护 → 数据与运行」里可以导出全量 JSON（项目、里程碑、风险、周报、计划、依赖等），导入会覆盖业务数据，账号不受影响。适合迁移和临时留档，日常备份还是用 `.db` 快照。

### 重置演示数据

停服务，删除 `data/pmo.db`，重新启动。会重新生成演示数据。

### 清空业务数据（正式上线前）

「管理维护 → 数据与运行 → 清空业务数据」，输入「清空」确认。也可以直接调接口：

```bash
curl -b cookie.txt -H 'Content-Type: application/json' \
  -d '{"confirm":"清空"}' https://pmo.example.internal/api/admin/clear-demo
```

清理范围：

- 删除全部项目、里程碑、风险、投入、周报、计划、版本、评论、关口、依赖、章程、变更、经验教训和旧审计记录；
- 删除其他所有账号和会话，只保留当前 PMO 管理员，当前登录不掉线；
- 项目群重置为「默认项目群」，总览变成三步引导，可以直接新建第一个项目。

建议先执行 `npm run backup` 或导出 JSON 再清理。清空后旧的项目编号可以重新使用。

---

## 5. Linux 服务化（systemd）

假设程序放在 `/opt/pmo`，数据放在 `/var/lib/pmo`：

```bash
sudo useradd -r -s /usr/sbin/nologin pmo
sudo mkdir -p /opt/pmo /var/lib/pmo
sudo cp -r pmo-program-console-1.32.0/* /opt/pmo/
sudo chown -R pmo:pmo /opt/pmo /var/lib/pmo

sudo cp /opt/pmo/deploy/pmo.service /etc/systemd/system/pmo.service
sudo systemctl daemon-reload
sudo systemctl enable --now pmo
sudo systemctl status pmo
```

`deploy/pmo.service` 默认监听 `127.0.0.1:5177`，数据库在 `/var/lib/pmo/pmo.db`。改端口或路径直接改 unit 里的 `Environment`。

日志：

```bash
journalctl -u pmo -f
```

---

## 6. Nginx 反向代理 + HTTPS

参考 `deploy/nginx.conf`：

- 80 跳 443；
- 反代到 `127.0.0.1:5177`；
- 保留 `Host` 头（服务端会做同源校验）；
- `proxy_cookie_flags pmo_sid secure httponly samesite=lax` 给会话 Cookie 补 `Secure`。

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/pmo.conf
sudo nginx -t && sudo systemctl reload nginx
```

应用本身已经设置了 CSP、X-Frame-Options、nosniff、Referrer-Policy 等响应头。只要 Nginx 传了 `X-Forwarded-Proto https`，应用会自动：

- 给会话 Cookie 加 `Secure`；
- 给响应加 `Strict-Transport-Security`。

Nginx 示例已经包含这一行。如果是应用直接跑 TLS（不推荐），设 `PMO_SECURE_COOKIE=1`。

如果内网没有域名，也可以直接用 `http://服务器IP:5177`，但密码和会话会明文传输，只适合隔离测试网。

---

## 7. Docker（可选）

```bash
docker compose up -d --build
```

- 数据卷 `./data:/data`，数据库在宿主机 `data/pmo.db`；
- 端口 `5177`；
- 镜像基于 `node:22-alpine`，构建时不需要联网装依赖（只要本地有基础镜像）。

内网无法拉取 `node:22-alpine` 时，先在外网 `docker pull node:22-alpine`，`docker save` 成 tar 拷进去 `docker load`，再构建。

---

## 8. 上线前安全检查清单

- [ ] 改掉 `pmo` 和所有 `pm*` 演示账号的密码，或停用不用账号。
- [ ] 给真实项目经理建账号，按项目授权。
- [ ] 用「清空业务数据」删除演示项目、周报、计划、关口、依赖和其他账号，只保留管理员。
- [ ] 服务只监听 `127.0.0.1`，由 Nginx 对外；或至少用防火墙限制来源网段。
- [ ] 配 HTTPS，确认登录 Cookie 带 `Secure`。
- [ ] 关闭公网访问；远程接入走 VPN / 零信任网关。
- [ ] 配每日备份，并实际做一次恢复演练。
- [ ] 确认服务器时区正确（周报按 ISO 周、截止时间按本地日期）。
- [ ] 关注磁盘：SQLite WAL 会随写入增长，备份后正常回收。
- [ ] 审计日志目前没有自动保留策略，定期导出或清理。

当前没有 SSO / LDAP / MFA，账号是本地账号体系。对安全要求高的环境，建议把整个服务放在零信任网关后面，不要直接暴露。

---

## 9. 二次开发指南

### 目录与职责

| 文件 | 负责什么 |
| --- | --- |
| `server.js` | 建表与种子数据、认证会话、权限、周报/计划状态机、阶段关口、依赖、报表生成、静态文件 |
| `public/app.js` | hash 路由、各视图、表单、自动保存、版本与评论、甘特图 |
| `public/app.css` | 视觉系统与响应式 |
| `tests/api.test.js` | 接口集成测试，使用临时数据库 |

前端没有构建步骤，改完 `public/` 刷新页面即可；改 `server.js` 需要重启 Node。

### 测试

```bash
npm test
```

测试会启动一个独立服务（端口 5197）和临时数据库，不会碰 `data/pmo.db`。加功能时优先补接口测试。

如果想手工起一个隔离环境：

```bash
PMO_PORT=5188 PMO_DB=/tmp/pmo-dev.db node server.js
```

### 数据库结构版本

`PRAGMA user_version = 20`。新增表用 `CREATE TABLE IF NOT EXISTS`；改已有表时按版本加迁移，例如：

```js
const version = db.prepare('PRAGMA user_version').get().user_version;
if (version < 5) {
  db.exec('ALTER TABLE projects ADD COLUMN ...');
  db.exec('PRAGMA user_version = 5;');
}
```

不要在已有库上直接改 `CREATE TABLE` 的字段定义，SQLite 不会自动迁移。

### 加一个页面的步骤

1. `public/app.js` 顶部 `parseRoute` 的 `known` 数组加路由名；
2. `render()` 的 `switch` 加 `case`；
3. 写 `viewXxx()` 返回 HTML；
4. 侧栏 `renderNav()` 加一项；
5. 需要写操作时，在 `handleApi` 里加接口，并想清楚 `requirePmo` / `requireProject`。

### 权限约定

- `requireProject(me, projectId)`：PMO 或该项目被授权的项目经理；
- `requirePmo(me)`：只有 PMO；
- 前端隐藏按钮只是体验，服务端必须再校验一次；
- 写接口会做 Origin 同源校验，新增写接口不用重复写。

### 编码约定

- **保持零依赖**：能用 Node 内置模块就不要加 npm 包，内网离线部署会轻松很多。
- 所有来自数据库的文本渲染前走 `esc()`；富文本用 `multiline()`。
- 时间统一用 `YYYY-MM-DD` 字符串，周期用 ISO 周一 / `YYYY-Qn`。
- 金额单位是万元，百分比是 0–100 的整数。
- 不要新增内联 `<script>`，CSP 只允许同源脚本；内联样式可以用，`style-src` 已放行 `'unsafe-inline'`。

### 演示数据在哪

`server.js` 里搜索：

- `SEED_PROJECTS`：项目、里程碑、风险、投入；
- `seedUsers()`：演示账号；
- `seedDeliverables()`：周报、计划、版本与评论；
- `seedGates()`：阶段关口；
- `seedDependencies()`：跨项目依赖；
- `seedPmp()`：项目章程、变更请求、经验教训。

正式部署前建议把这些改成你们自己的项目群数据，或者先删掉演示数据再录入。

---

## 10. 常见问题

**端口被占用**

```bash
PMO_PORT=5188 node server.js
```

**提示 Node 版本过低**

`node:sqlite` 需要 22.5+。升级 Node，或在内网机器上装 22 LTS。

**登录提示尝试次数过多**

连续 5 次密码错误会锁 10 分钟，重启服务可以清掉内存里的计数。

**周报/计划提交后改不了**

状态为「待审核 / 已通过」时锁定。需要 PMO 退回或撤回审核后才能改。

**页面空白**

先看浏览器控制台和 `journalctl -u pmo`。静态资源路径不对、CSP 拦截、服务没起来都会表现为空白。

**备份文件多大**

空库约 150 KB，日常使用通常几 MB 到几十 MB，取决于历史填报和审计记录。

---

需要继续加功能时，先跑一遍 `npm test`，确认基线是绿的，再改。
