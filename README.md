# ADS-B Hub

个人 ADS-B 接收站的实时地图、历史航迹和基站状态页。`adsb collector` 在 Orange Pi 上接收 readsb 数据，先写本地 SQLite，再批量发给 `adsb server`。服务端写 PostgreSQL，并在同一端口提供查询 API 和 Leaflet 页面。

## 本机构建与联调

需要 Go 1.25+、Node.js 22.12+（22 LTS 或更新）和一个 PostgreSQL 实例。先构建 React，再由 `go:embed` 将 `frontend/dist` 打进 Go 二进制，构建后的程序可以独立运行。

```sh
npm --prefix frontend ci
npm --prefix frontend run build
go build -o bin/adsb ./cmd/adsb
go test ./...
```

Windows 上将二进制路径写成 `bin/adsb.exe`。本地也可以通过 Docker 启动 PostgreSQL 17，已有 PostgreSQL 时创建一个空库即可。应用启动时会建表和登记基站，连接用户需有对应权限。

```sh
docker run --rm --name adsb-pg -e POSTGRES_USER=adsb -e POSTGRES_PASSWORD=adsb -e POSTGRES_DB=adsb -p 127.0.0.1:5432:5432 postgres:17
```

在三个终端分别启动模拟 readsb、服务端和采集器。模拟器每秒发送位置事件，并生成 `receiver.json`、`stats.json` 和 `status.json`。

```sh
go run ./cmd/mock-readsb
```

```sh
DATABASE_URL='postgres://adsb:adsb@127.0.0.1:5432/adsb?sslmode=disable' \
ADSB_RECEIVERS='[{"id":"demo","name":"上海模拟站","token":"local-demo-token"}]' \
./bin/adsb server
```

```sh
ADSB_INGEST_URL=http://127.0.0.1:8080/api/v1/ingest \
ADSB_TOKEN=local-demo-token ADSB_READSB_DIR=data/mock-readsb \
./bin/adsb collector
```

PowerShell 中用 `$env:变量名 = '值'` 逐个设置变量，再运行 `./bin/adsb.exe server` 或 `./bin/adsb.exe collector`。打开 <http://127.0.0.1:8080>。等几秒可看到三架模拟飞机。从地图上方搜索 `CES528`、`00a7e1` 或 `~003ab2` 可定位飞机。右下角选择时间档可查看当前基站的全部历史航迹。底图使用 Esri World Imagery，浏览器需要能访问其瓦片服务。

## 部署到 Orange Pi 和 NAS

在构建机上先构建前端，再生成不依赖 CGO 的 Linux ARM64 二进制：

```sh
npm --prefix frontend ci
npm --prefix frontend run build
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o bin/adsb-linux-arm64 ./cmd/adsb
```

PowerShell 中分别设置 `$env:CGO_ENABLED = '0'`、`$env:GOOS = 'linux'` 和 `$env:GOARCH = 'arm64'` 后执行同一条 `go build`。NAS 或云服务器按其 CPU 架构构建，在服务端配置 `DATABASE_URL` 以及每个基站的独立令牌。服务端依据令牌选择基站 ID。跨网络上传时使用 HTTPS 入口。查询页面和查询 API 由服务端监听地址提供，公开部署时可在反向代理或私有网络上控制访问。

### 开启 readsb 的本地 TCP 位置流

先在 Orange Pi 上执行 `systemctl cat readsb`，确认 unit 的 `ExecStart` 和 `EnvironmentFile`，再用 `systemctl show -p ExecStart readsb` 核对启动配置。常见打包方式会读取 `/etc/default/readsb`。若 unit 从该文件读取 `NET_OPTIONS`，用 `sudoedit /etc/default/readsb`，在已有网络参数上追加：

```text
--net --net-bind-address 127.0.0.1 --net-json-port 30006
```

保留现有 SDR、增益、PPM、位置、JSON 输出目录及其他网络参数。已有的 `--net` 只保留一份。若绑定地址或 JSON 端口已配置，更新相应参数，避免重复。`--net-bind-address` 会影响 readsb 的其他 TCP 监听器，先确认现有客户端的连接方式。如果 unit 直接写死了 `ExecStart`，用 `sudo systemctl edit readsb` 创建覆盖，先写空的 `ExecStart=`，下一行完整复制现有命令并追加参数。修改 unit 后执行 `sudo systemctl daemon-reload`。

```sh
sudo systemctl restart readsb
sudo systemctl status readsb
ss -ltn | grep ':30006'
nc 127.0.0.1 30006
```

有位置事件时，`nc` 会看到每行一个 JSON 对象。readsb 没有收到飞机位置时，连接可以保持空闲。部署采集器时建议给 `ADSB_QUEUE_PATH` 使用绝对路径，如 `/var/lib/adsb/queue.sqlite` 或 SSD 上的路径，并让服务用户拥有该目录写权限。运行 `adsb collector` 时提供基站令牌和完整上传地址。

### 环境变量

在采集器的 `collector.env` 中同时填写 `ADSB_LAT`（纬度）和 `ADSB_LON`（经度），使用十进制度。重启 `adsb-collector.service` 后，采集器会随启动样本上报坐标。两项留空时沿用 `receiver.json` 中的坐标。

| 进程 | 变量 | 默认值或用途 |
| --- | --- | --- |
| server | `DATABASE_URL` | 必填，PostgreSQL URL |
| server | `ADSB_RECEIVERS` | 必填，`{"id","name","token"}` 对象组成的 JSON 数组 |
| server | `ADSB_LISTEN` | `127.0.0.1:8080` |
| server | `ADSB_LIVE_MAX_AGE_SECONDS` | `60`，实时位置有效期 |
| collector | `ADSB_INGEST_URL` | 必填，含 `/api/v1/ingest` 的完整 HTTP(S) URL |
| collector | `ADSB_TOKEN` | 必填，与服务端配置的基站令牌一致 |
| collector | `ADSB_READSB_ADDR` | `127.0.0.1:30006` |
| collector | `ADSB_READSB_DIR` | `/run/readsb` |
| collector | `ADSB_QUEUE_PATH` | `data/queue.sqlite`，每个队列由一个采集器进程使用 |
| collector | `ADSB_QUEUE_LIMIT` | `100000` 条待上传事件 |

## 时间、补传和查询

- [readsb v3.16.21 TCP 输出](https://github.com/wiedehopf/readsb/blob/v3.16.21/net_io.c) 调用位置序列化，写出 [Unix 秒 `now` 和秒数 `seen_pos`](https://github.com/wiedehopf/readsb/blob/v3.16.21/json_out.c)。位置时间是 `now - seen_pos`，精度到毫秒。缺少任一字段时取采集时间，并保存近似标记。采集器直接处理 TCP 位置事件。
- `receiver.json` 在启动时读取，`stats.json` 与 `status.json` 启动后立即采样，随后每分钟读一次。后两者用各自文件里的 `now`，缺省时用采集时间。报文速率取 [readsb v3.16.21 统计窗口](https://github.com/wiedehopf/readsb/blob/v3.16.21/stats.c) 的 `last1min.messages_valid / (end - start)`。状态页以最新的统计或状态样本判断采样是否正常，超过 3 分钟显示超时，飞机数量可以为零。
- SQLite 每秒或累计 128 条写一批。容量满时保留已入队记录，拒绝超出的新事件并记警告。上传失败时按 1 秒到 1 分钟退避。服务端事务提交后返回 `204`，采集器收到 `204` 后才删除队列记录。重试沿用原 `event_id`。需要移动队列时先停止采集器，再移动 SQLite 文件及仍存在的 `-wal`、`-shm` 文件。
- PostgreSQL 的三张表是 `receivers`、`receiver_status` 和 `position_points`。最新状态按每个文件的采样时间选取。实时 API 按每站每机的位置时间取最新点，网页每两秒轮询，并在位置过期后隐藏。查询航迹按 `(receiver_id, hex, position_at)` 走索引，`hex` 保留前导零和 `~`。高度用英尺、地速用节、航迹角用度。缺省字段是 SQL `NULL`，`alt_baro: "ground"` 存为高度 `NULL` 和 `on_ground=true`。

| API | 用途 |
| --- | --- |
| `POST /api/v1/ingest` | 携带 `Authorization: Bearer <token>` 上传一批事件 |
| `GET /api/v1/live?receiver_id=demo` | 近期位置，每站每机一条，支持省略基站过滤 |
| `GET /api/v1/track` | 必填 `receiver_id`、`hex`、`from` 和 `to`，时间用 RFC3339，范围左闭右开，每次最多 20,000 条。可选 `sample_seconds` 为每个时间桶保留一个点 |
| `GET /api/v1/aircraft` | 按 `q` 模糊搜索呼号或 HEX，同时传入 `receiver_id`、`from` 和 `to`，最多返回 20 架飞机 |
| `GET /api/v1/trails` | 按 `receiver_id`、`from` 和 `to` 返回 `routes`、位置点数和实际数据起止时间。保留窗口内的全部位置点，在长时间断点处分段 |
| `GET /api/v1/receivers` | 基站和各文件的最新采样 |
