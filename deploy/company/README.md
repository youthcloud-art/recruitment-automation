# 公司服务器发布与维护

当前目标入口为 `http://192.168.1.24:4001/`，保留旧项目 4000。网关统一提供 React 页面、API 和 Socket.IO；招聘后端仅监听服务器回环地址，当前实测选用 `127.0.0.1:19501`。`delivery/config.json` 的 `gatewayPort` 和 `backendPort` 指定这两个端口。早期准备包缺少这些配置时按旧网关 4000、后端 5001 兼容读取。员工连接公司有线或获准的 Wi-Fi 后使用同一个地址，不在员工电脑安装后端。

代码流向固定为 **GitHub 的 main → Gitee 镜像 main → 公司服务器每 5 分钟拉取**。GitHub 是开发源；Gitee 保存同一提交的代码镜像；简历、附件、招聘网站浏览器配置、模型密钥和运行数据只保存在服务器 `shared`，不进入两个代码仓库。

## 服务器目录

部署根目录固定采用 `D:\App\SXF\Smart-Recruitment-Agent`，安装、自动更新、代码版本、业务数据、日志和备份均放在该目录下。

- `releases\时间-提交-随机值`：每次重新准备的代码、独立依赖及前端构建。
- `shared\backend-storage`：通过 release 内的 `backend\storage` 目录 junction 访问。
- `shared\backend-uploads`：通过 `backend\uploads` junction 访问。
- `shared\local`：通过根目录 `.local` junction 访问，保留本地业务库、模型设置及浏览器数据。
- `shared\backend.env`：后端真实环境配置，运行时通过 `RECRUITMENT_ENV_FILE` 直接读写该绝对路径。这样网页保存邮箱配置的原子替换也会保存在 shared，不在 release 内创建 `.env` 或文件链接。
- `shared\auth\users.json`：公司网页的管理员账号、加盐密码哈希和会话签名密钥。首次设置时由网关创建；不进入 Git、release 或日志。发布切换时保留，因此更新代码无需重新设置密码。
- `control\current-release.json`：当前代码指针；`control\processes.json` 记录可核实的子进程身份。
- `delivery`：固定维护脚本、配置、Gitee 只读部署密钥及执行结果。
- `backups`：切换前 Node 服务停止后的 shared 业务副本及上一版代码指针；不包含仍可能被可见 Chrome 使用的 `local\browser-profiles`。
- `logs`：网关与后端日志。

不直接修改正在运行的 release。升级先安装新依赖、构建前端并检查 JavaScript 语法，通过后才停服；冷备份 shared 中的业务数据后切换代码指针，再检查 `/healthz`。失败会停止新实例，恢复业务数据和上一版代码，再启动旧版。备份与恢复均排除 `browser-profiles`，保持 Chrome 登录会话原位供新旧版本接管；会话记录与采集检查点仍随其他业务数据备份。首次替换旧觅才项目时，保留其整个目录和业务数据，不混入 AutoRecru。

## 管理员登录

公司正式版本启用单一管理员账号 `Mark`。新版首次发布后，在**公司服务器本机浏览器**打开 `http://192.168.1.24:4001/`，按页面提示设置密码一次；远端设备不能初始化或重设账号。初始密码不得写入代码、Git、命令行或工单。后续公司网段内的浏览器使用账号密码登录，右上角账号菜单可修改密码或退出。登录在该浏览器中持久保存，活跃使用时会自动续期；浏览器清除 Cookie、长期不使用、修改密码或退出后须重新登录。修改密码和退出都会使该账号现有登录窗口的会话失效。连续输错五次会暂时限制登录 15 分钟。健康检查 `/healthz` 保持匿名可用，所有简历 API 与 Socket.IO 在未登录时拒绝访问。

当前入口为 HTTP；账号密码和候选人数据在公司网段传输时没有 TLS 加密。正式把它当作访问控制边界前，应由公司 IT 为此入口配置可信任的内部 HTTPS 反向代理或证书，并确认网关收到的仍是真实客户端地址及同源请求；不能仅依靠登录功能保护不可信网络传输。模型配置写入仍按此前要求只允许服务器本机浏览器。

## 一次性准备

在服务器管理员 PowerShell 中运行 `Inspect-Company.ps1`，核实系统、Node 路径、4000 监听进程以及旧服务、监控、备份任务的真实任务名和工作目录。该脚本只读，输出不含进程命令行参数或业务数据。文档中的历史名称不能代替服务器实测。

服务器需要 Node.js 24 或更高版本、npm、Git for Windows（含 OpenSSH）和已安装的 Chrome。使用固定 Windows 运行账户。后端与 Chrome 由 `AutoRecru-Company-Runtime` 以 **Interactive** 计划任务运行，以便维护人员进入同一 Windows 会话完成招聘网站登录。保持此账户登录；断开远程桌面可继续运行，注销账户会结束交互进程，服务器重启后须重新登录该账户。脚本不修改自动登录或公司会话策略。

**当前并行部署入口**：使用新版包的 `Start-New-Port.cmd`，它调用 `Activate-CompanyServer.ps1 -Parallel -Commit <完整提交>`。脚本核验原准备包或 `c93ad35` 的部署脚本哈希，保留原数据、配置及部署密钥，并检查 4001、19501、19502 可用；从 Gitee 拉取、构建并通过回环预检后，自动在 4001 启动新助手并启用每 5 分钟的镜像更新。它不会进入 `Read-Host` 或要求输入 SWITCH，不需要停止旧 4000 程序。防火墙仅新增已确认公司网段访问本机 Node 的 4001 规则。桌面 `AutoRecru-Deployment-Result.json` 记录新地址及结果。以下不带 `-Parallel` 的 4000 替换流程仅保留作历史维护说明。

Gitee 仓库预期为 `felixshe/auto-recru-company`，为 GitHub 对应私有仓库设置单向 Pull 自动镜像。镜像完成后核对 main 的完整 40 位提交一致。GitHub 镜像授权、模型密钥均通过对应服务的管理界面保存，不写进脚本。

首次可从 GitHub 或 Gitee 下载该**完整提交**的 ZIP，先校验下载文件 SHA-256，再解压到服务器桌面的临时 `AutoRecru-Bootstrap` 文件夹。准备入口会自动在 `D:\App\SXF\Smart-Recruitment-Agent` 创建正式部署目录；临时源码包与正式运行目录分开，以便安装器校验目标目录和保留已有数据。

首次准备可直接在服务器管理员 PowerShell 运行 `deploy\company\Prepare-CompanyServer.ps1 -Commit <完整提交SHA>`。它先把只读检查结果保存为当前用户桌面的 `AutoRecru-Server-Check.json`；缺少 Node.js 24+、npm 或 Git 时停止，不改旧服务。环境齐全时调用下方安装器的 `-PrepareOnly`，准备依赖、前端和只读部署公钥，最后显示 `.pub` 公钥。将检查结果及公钥提供给部署维护者，核实旧服务路径、任务和 Gitee 只读权限后再进行切换。该入口不会停止旧服务，也不会启用自动部署任务。

需要自定义参数时，下面的源码路径、提交及 Windows 账户按实际值替换：

```powershell
$source = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoRecru-Bootstrap'
$commit = '<已核对的40位提交SHA>'
& "$source\deploy\company\Install-Company.ps1" `
  -InitialRepositoryRoot $source -Commit $commit `
  -InstallRoot 'D:\App\SXF\Smart-Recruitment-Agent' `
  -RunAs '<服务器上已登录的固定Windows账户>' `
  -AllowedNetworks @('192.168.1.0/24','192.168.11.0/24') `
  -OpenFirewall -PrepareOnly
```

`-PrepareOnly` 创建新项目自身任务、部署公钥、依赖与构建，保留旧服务运行。自动镜像部署任务保持禁用。新安装器默认网关 4001；脚本创建的新防火墙规则仅允许这些已确认公司网段到服务器配置的网关端口；若已有同名规则则停止，不覆盖。不同 Wi-Fi 可能属于不同 VLAN，Wi-Fi 名本身不能证明所处网段或路由权限。后端端口不向局域网发布。

### 新公司 Wi-Fi 无法访问 4001

先在连接该 Wi-Fi 的电脑上记录 IPv4 地址、前缀长度、默认网关，并运行 `curl.exe --noproxy '*' --connect-timeout 4 --max-time 8 -i http://192.168.1.24:4001/healthz`。`HTTP 403` 且提示不在公司网段，说明请求到达了网关，但来源地址未获准；连接超时则先检查该 Wi-Fi 到 `192.168.1.24` 的 VLAN 路由、访客/客户端隔离和防火墙，不要直接扩大放行范围。服务器本机 `/healthz` 正常只能证明应用在运行，不能证明该 Wi-Fi 有路由。

确认它是受信任的公司网段、存在到服务器的路由后，在服务器管理员 PowerShell 从**当前 release** 执行 `Add-CompanyNetwork.ps1 -Network '<该 Wi-Fi 的准确 IPv4 CIDR>'`。脚本核实本机服务器身份、当前网关支持动态加载和专用防火墙规则，暂缓镜像部署，再同时修改 `delivery/config.json` 与该规则的来源地址；待运行中的网关报告已加载新名单且健康检查通过后结束，失败时回滚。它不重启采集后端、网关或招聘平台 Chrome，也不暂停正在运行的采集。成功后必须再从该 Wi-Fi 的电脑访问 `/healthz` 和页面验证。若脚本输出 `NETWORK_ALREADY_ALLOWED` 但仍超时，应由公司网络管理员检查 Wi-Fi/VLAN 的互访策略；本项目不能绕过网络设备的隔离规则。不要改成 `Any` 或向所有来源开放端口。

若服务器仍运行旧网关而新版已进入 `source`，管理员可运行 `source\deploy\company\Repair-And-Enable-CompanyNetwork.ps1 -ExpectedCommit <完整提交> -Network <准确 CIDR>`。它先将交付脚本的发布健康等待从 90 秒修正为 600 秒，等待新版真正通过健康检查，再调用上面的热加载脚本。公司数据量增长后实测后端冷启动约 4 分钟，原 90 秒等待会错误回滚。修正等待时间本身不重启当前服务；正式发布切换仍可能短暂不可用。

把服务器 `delivery\gitee-readonly-ed25519.pub` 的**公钥**添加到 Gitee 仓库的只读部署公钥。私钥留在服务器，仅 SYSTEM 和管理员可读。

如果初次报告未识别旧服务任务，运行 `Inspect-Deployment.ps1` 补充检查。它把报告写到桌面 `AutoRecru-Deployment-Check.json`，列出 4000/5001/19501 的进程父链、确实存在的启动文件路径、非 Microsoft 任务、关联 Windows 服务及新版本构建情况；不输出完整命令行、配置或密钥，也不停止进程或修改部署。19501 仅作为待选后端端口，检查本身不会改变当前端口配置；须在切换前按实际占用结果调整。

2026-10-22 补充报告确认：旧 4000 程序由手动 PowerShell 启动，5001 属于 PID 4，19501 空闲，初始版本 `4e01e84` 已构建。为此提供专用 `Activate-CompanyServer.ps1 -Commit <完整提交>`：核对固定目录、同一运行账户、未激活状态及原有任务，按 `bootstrap-delivery-baseline.json` 校验部署脚本没有被手改，备份后更新固定维护脚本并把后端端口设为 19501；使用服务器只读密钥从 Gitee 拉取精确版本，安装依赖、构建，再在回环 19501/19502 实际启动验证。全程保持旧程序在线。通过后，操作人员在旧 PowerShell 按 Ctrl+C 保留原窗口与启动命令，再回到新窗口输入 `SWITCH`，脚本才在 4000 启动新版本并启用定时拉取。它不按报告中的历史 PID 杀进程，不动 PID 4 或营销项目。输出结果为桌面 `AutoRecru-Deployment-Result.json`。首次替换的旧手动程序没有已验证的自动重启命令，若首次激活失败，须在原窗口重新执行原启动命令；之后由本部署器管理的新旧 release 可按既有流程自动回滚。

确认准备完成后，把实测旧任务名和旧目录明确传给切换脚本。示例中的值必须替换；旧监控和备份任务也应按实际配置列入，防止旧服务被重新启动：

```powershell
$root = 'D:\App\SXF\Smart-Recruitment-Agent'
$prepared = Get-Content "$root\delivery\prepared-release.json" -Raw | ConvertFrom-Json
& "$root\delivery\Switch-Release.ps1" -InstallRoot $root `
  -ReleaseRoot $prepared.root `
  -LegacyInstallRoot '<已核实的旧招聘项目绝对路径>' `
  -LegacyTaskName @('<已核实的旧服务任务>','<已核实的旧监控任务>','<已核实的旧备份任务>')
Enable-ScheduledTask -TaskName 'AutoRecru-Company-MirrorDeploy'
Start-ScheduledTask -TaskName 'AutoRecru-Company-MirrorDeploy'
```

脚本先验证每个旧任务的工作目录或参数确实引用指定旧目录，再停用这些任务。未知的 4000/已配置后端端口监听进程只会导致停止执行，**不会按端口盲目杀进程**。若旧服务是手动窗口、Windows Service 或其他方式启动，先核实并使用其原管理方式正常停止，再运行切换；本脚本不猜测服务名。

## 日常发布

开发者运行相关测试，确认仓库没有简历、密钥和运行目录，提交精确发布内容后执行：

```powershell
& '.\deploy\company\Publish-Company.ps1'
```

该脚本先审计已提交的文件，推送 GitHub 并读取远端完整提交；只有 GitHub 确认收到同一提交后才检查 Gitee。若原生镜像尚未同步，脚本用开发机现有 Git 凭据将同一提交同步到 Gitee，再读取远端核验；不会强制推送，也不会把账号密码或新令牌放到服务器。Gitee 与 GitHub 存在分叉时停止，保留 GitHub 提交。日常发布应使用此脚本，单独执行 `git push origin` 仍依赖原生 Webhook 的可用性。

截至 2026-10-22，当前私有仓库的 Gitee 原生回调对 GitHub 的 ping 与实际 push 均返回 403，手动 Pull 可以完成；上述同步兜底用于保证既定的 GitHub → Gitee → 公司服务器链路。需要只验证原生镜像、不允许开发机同步时，可使用 `Publish-Company.ps1 -RequireNativeMirror`，默认最多等待 600 秒。

服务器的 `AutoRecru-Company-MirrorDeploy` 以 SYSTEM 身份准备新版本，再启动交互运行任务；构建失败时现有服务继续运行。固定 delivery 脚本不会随 Git 拉取自动覆盖，修改部署机制后应单独审阅并更新服务器 `delivery` 内脚本。

### 已安装服务器的一次性运行可靠性更新

当 `control\current-release.json` 指向包含 `Apply-CompanyReliability.ps1` 的新版本后，在**服务器本机管理员 PowerShell** 运行一次：

```powershell
$root = 'D:\App\SXF\Smart-Recruitment-Agent'
$current = Get-Content "$root\control\current-release.json" -Raw | ConvertFrom-Json
& (Join-Path $current.root 'deploy\company\Apply-CompanyReliability.ps1') -InstallRoot $root
```

脚本核对服务器 IP 和当前版本，暂时禁用后续镜像任务并最多等待 20 分钟让当前部署释放锁；随后备份旧维护脚本，更新固定 `delivery` 脚本，仅重启本项目后端和网关并校验 `/healthz`，再安装每 2 分钟检查一次的 `AutoRecru-Company-Watchdog`。脚本结束时恢复镜像任务原有的启用状态。招聘平台的独立 Chrome 窗口及浏览器资料不会被脚本关闭。若运行任务仍显示 Running 但健康检查失败，监测任务只记录异常，不杀进程；任务已停止且端口空闲时才尝试恢复。更新失败会恢复旧脚本并尝试启动旧运行任务。成功时显示 `RELIABILITY_UPDATE_OK`，详情写入 `delivery\last-reliability-update.json`。

故障诊断依次查看 `control\runtime-failure.json`、`delivery\last-watchdog.json`、`logs\backend.stderr.log` 和 `logs\gateway.stderr.log`。每次重启会把非空的旧日志存成同目录带时间戳的文件，各流保留最近 10 份，便于定位重启前的异常。`node` 的 `ExperimentalWarning` 本身不能说明服务为何退出；应结合运行任务状态与故障记录判断。计划任务以交互账户启动浏览器相关进程，服务器重启或该账户注销后仍需先登录该 Windows 账户。

服务器查看状态：

```powershell
Get-ScheduledTask -TaskName 'AutoRecru-Company-*' | Select-Object TaskName,State
Get-Content 'D:\App\SXF\Smart-Recruitment-Agent\delivery\last-sync.json'
Get-Content 'D:\App\SXF\Smart-Recruitment-Agent\delivery\last-deployment.json'
Get-Content 'D:\App\SXF\Smart-Recruitment-Agent\control\current-release.json'
```

首次准备的依赖安装若失败，修正原因后重跑原 `Install-Company.ps1` 命令并增加 `-Resume`。它要求原提交、账户、网段、仓库及运行路径全部一致，验证已有任务与防火墙规则；保留 shared、backend.env 和部署私钥。已有当前版本指针的正式安装不能使用 Resume。也可单独运行 `delivery\Prepare-Release.ps1 -InstallRoot ... -SourceRoot ... -Commit ...`，然后按上文切换。不要删 shared 或重新覆盖真实环境配置来修复安装。

## 验收与恢复

### 每日清理旧部署文件

清理任务固定为 `AutoRecru-Company-Cleanup`，以 SYSTEM 在北京时间每天 **12:30、20:00** 执行。XML 的两个 CalendarTrigger 都明确包含 `+08:00`，不依赖服务器当前显示时区；错过的任务可在服务器可用时补执行。它不需要本地电脑或 Codex 开机。

发布本功能后，服务器既有 SYSTEM 镜像任务执行 `backend npm ci` 时，由 `postinstall` 调用受限安装器。只有 `D:\App\SXF\Smart-Recruitment-Agent\releases\<标准版本目录>`、已初始化的指定 Gitee 仓库、服务器 IP 和 SYSTEM 身份全部吻合时才安装；开发电脑的 npm install 直接跳过。安装器将维护脚本保存为 `delivery/maintenance/<内容哈希>` 的不可变副本，避免正在运行的 release 更新或清理影响计划任务。若已有同名但不属于本安装器的任务则拒绝覆盖。

默认策略为：至少保留最近 3 个完整版本，另外保护当前版本、待切换版本、进程正在引用的版本和最近 2 个历史回滚版本；24 小时内的完整版本不删。未完成的失败构建目录在 4 小时后成为清理候选，失败构建会先在当次发布结束时立即尝试清理。自动切换备份至少保留最新 7 份、最近 7 天的全部备份及当前部署/保留回滚链所需备份。48 小时前的遗留 release ZIP，以及 14 天前的非活动日志可以清理。当前版本、整个 shared（含数据库、简历附件、模型/邮箱配置和浏览器登录资料）、source Git 仓库、手动 data-export 包、setup 备份、活动后端/网关日志和未知目录全部保留。只清除这些已审阅范围内的旧文件，不清整个 D 盘，也不清其他项目。

`delivery/cleanup-policy.json` 可增加保留量或延长期限，不能低于上述安全下限。清理先取得 `sync.lock`、`switch.lock`、`cleanup.lock` 和 `maintenance-install.lock`；遇到更新、导出或另一轮清理就跳过，不停止任何业务进程。健康检查异常时不清理；执行中变为异常则停止后续项。删除器先完整检查目录树，遇到未知 reparse point 整项拒绝，已知 shared junction 仅移除链接，文件和空目录均逐项非递归删除，不遍历共享数据。

安装结果记录在 `delivery/cleanup-installation.json`，每次预览或执行结果记录在 `delivery/last-cleanup.json`，包括候选/删除数量、字节数和前后磁盘剩余空间。公司平台只读接口 `/api/company-maintenance/status` 提供计划和汇总，不暴露文件名、配置内容或进程命令行。网关 `/healthz` 另提供最小的 `cleanup` 注册标记、北京时间计划和上次删除计数，便于内网运维验证；业务接口仍须登录，详细路径、报错、配置和账号信息不进入健康响应。手动核对可读取这些 JSON 和 `Get-ScheduledTask -TaskName AutoRecru-Company-Cleanup`；手动预览运行安装记录对应 bundle 中的 `Invoke-CompanyCleanup.ps1 -InstallRoot ...`，只有额外传 `-Apply` 才删除。

每次镜像发布前若应用所在磁盘剩余不足 24 GiB，会先通过已安装的安全清理任务尝试回收过期部署文件；60 分钟内已执行过一次的清理不重复扫描。低空间时，未使用的完整版本在 2 小时后、失败构建在 1 小时后即可成为清理候选，最近版本、当前/待切换版本、进程引用版本及回滚链仍按原规则保护；自动备份、简历和附件不缩短保留期。回收后不足 16 GiB 就延后新构建，保留运行中的版本。构建入口再次检查 16 GiB 门槛，避免并发占用造成低空间构建。定时清理后仍不足 16 GiB 时，状态记录为 `low_space`，并在健康/维护状态中标明；它不会为达到门槛而删除受保护的数据。更新这两个固定交付脚本后，需从已生效版本运行一次 `Apply-CompanyReliability.ps1`，让服务器 `delivery` 中的未来镜像任务使用新版逻辑。

清理能控制历史部署文件的增长，正常业务数据、手动导出和当前活动日志仍会随使用增长；它们不会因磁盘空间低而被自动删除。低空间且无安全清理候选时，新增部署会延后，并应检查这些受保护目录或其他项目的容量来源。

### 一次性将服务器业务数据同步到本地

此功能由操作人员按需运行，不创建定时数据同步，也不通过 GitHub/Gitee 传输业务文件。使用专用工具包中的 `Export-Server-Data.cmd`，以管理员身份在公司服务器执行。它先拒绝正在进行的采集，取得部署锁并暂时禁用镜像更新任务，短暂停止新助手，把固定白名单中的业务数据复制到 `backups/data-export-.../snapshot`；对副本中的 SQLite WAL 完成检查点和完整性检查后恢复服务，再生成 ZIP 与 SHA-256。原服务及镜像任务状态在正常或异常退出时都会尝试恢复。浏览器 profile 保留原位，导出不关闭 Chrome；若应用之外还有进程直接写业务目录，须先停止该写入者。

同步范围为简历库、简历附件、知识库数据库与上传文件、任务、当前岗位及发信回执/报告更正记录。模型密钥、`backend.env`、邮箱密码、部署私钥、浏览器登录状态、采集检查点、日志和代码不在导出范围内。导出 ZIP 和校验文件都保存在服务器部署根目录的 `backups`，桌面 `AutoRecru-Data-Export-Result.json` 只记录结果和路径。

把 ZIP 及其 `.zip.sha256` 文件通过远程桌面复制到本地项目之外的 Downloads。停止本地助手后运行 `scripts/import-company-data.ps1 -Archive <ZIP路径>`。工具先校验整个压缩包、每个业务文件以及两边后端源码指纹，再在本地暂存并验证 SQLite，然后把原业务目录原样移入用户目录的 `Auto-Recru-Data-Sync/backups`，用服务器副本替换对应业务数据。它不合并两个数据库；本地模型、邮箱与浏览器配置保留。普通导入错误会逆序恢复已移动的原数据；硬断电或无法回滚时保留锁与 transaction.json，启动器会阻止带有未完成导入锁的本地实例启动，应先按备份事务修复，不要删除原数据库或导入锁。

先在服务器核对新端口 `/healthz` 返回 200，后端只监听已配置的回环端口（当前 19501）；再分别从公司有线、`@Ruijie-s7661`、`Unionwell` 对应的实际办公网段访问新端口 4001。确认页面、API、Socket.IO、招聘网站登录、一次授权的简历采集和保存，以及断开远程桌面后继续访问。代理/TUN 环境应让公司地址直连；仅本机健康成功不能代替跨网段验收。

每次升级的 `backups` 是单机业务数据切换恢复点，**浏览器 profile 不属于自动数据回退范围**。可见 Chrome 独立运行，不保证随 Node 停止；维护人员需要另外正常关闭这些 Chrome 窗口，再将完整 shared（含 browser-profiles）、backend.env、delivery 配置和所需 release 复制到公司受控备份位置，并验证恢复。不得在 Chrome 仍运行时覆盖 profile。历史自动备份与旧 release 按前述保留策略清理，独立异机备份仍须另行维护。正常维护先禁用镜像任务，再使用 `Stop-CompanyRuntime`（dot-source `delivery\Common.ps1` 并读取配置）；恢复使用 `Start-CompanyRuntime`，随后验证 `/healthz`。新数据库的有意破坏性迁移应先独立验证恢复路径。
