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
- `control\current-release.json`：当前代码指针；`control\processes.json` 记录可核实的子进程身份。
- `delivery`：固定维护脚本、配置、Gitee 只读部署密钥及执行结果。
- `backups`：切换前 Node 服务停止后的 shared 业务副本及上一版代码指针；不包含仍可能被可见 Chrome 使用的 `local\browser-profiles`。
- `logs`：网关与后端日志。

不直接修改正在运行的 release。升级先安装新依赖、构建前端并检查 JavaScript 语法，通过后才停服；冷备份 shared 中的业务数据后切换代码指针，再检查 `/healthz`。失败会停止新实例，恢复业务数据和上一版代码，再启动旧版。备份与恢复均排除 `browser-profiles`，保持 Chrome 登录会话原位供新旧版本接管；会话记录与采集检查点仍随其他业务数据备份。首次替换旧觅才项目时，保留其整个目录和业务数据，不混入 AutoRecru。

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

服务器查看状态：

```powershell
Get-ScheduledTask -TaskName 'AutoRecru-Company-*' | Select-Object TaskName,State
Get-Content 'D:\App\SXF\Smart-Recruitment-Agent\delivery\last-sync.json'
Get-Content 'D:\App\SXF\Smart-Recruitment-Agent\delivery\last-deployment.json'
Get-Content 'D:\App\SXF\Smart-Recruitment-Agent\control\current-release.json'
```

首次准备的依赖安装若失败，修正原因后重跑原 `Install-Company.ps1` 命令并增加 `-Resume`。它要求原提交、账户、网段、仓库及运行路径全部一致，验证已有任务与防火墙规则；保留 shared、backend.env 和部署私钥。已有当前版本指针的正式安装不能使用 Resume。也可单独运行 `delivery\Prepare-Release.ps1 -InstallRoot ... -SourceRoot ... -Commit ...`，然后按上文切换。不要删 shared 或重新覆盖真实环境配置来修复安装。

## 验收与恢复

### 一次性将服务器业务数据同步到本地

此功能由操作人员按需运行，不创建定时数据同步，也不通过 GitHub/Gitee 传输业务文件。使用专用工具包中的 `Export-Server-Data.cmd`，以管理员身份在公司服务器执行。它先拒绝正在进行的采集，取得部署锁并暂时禁用镜像更新任务，短暂停止新助手，把固定白名单中的业务数据复制到 `backups/data-export-.../snapshot`；对副本中的 SQLite WAL 完成检查点和完整性检查后恢复服务，再生成 ZIP 与 SHA-256。原服务及镜像任务状态在正常或异常退出时都会尝试恢复。浏览器 profile 保留原位，导出不关闭 Chrome；若应用之外还有进程直接写业务目录，须先停止该写入者。

同步范围为简历库、简历附件、知识库数据库与上传文件、任务、当前岗位及发信回执/报告更正记录。模型密钥、`backend.env`、邮箱密码、部署私钥、浏览器登录状态、采集检查点、日志和代码不在导出范围内。导出 ZIP 和校验文件都保存在服务器部署根目录的 `backups`，桌面 `AutoRecru-Data-Export-Result.json` 只记录结果和路径。

把 ZIP 及其 `.zip.sha256` 文件通过远程桌面复制到本地项目之外的 Downloads。停止本地助手后运行 `scripts/import-company-data.ps1 -Archive <ZIP路径>`。工具先校验整个压缩包、每个业务文件以及两边后端源码指纹，再在本地暂存并验证 SQLite，然后把原业务目录原样移入用户目录的 `Auto-Recru-Data-Sync/backups`，用服务器副本替换对应业务数据。它不合并两个数据库；本地模型、邮箱与浏览器配置保留。普通导入错误会逆序恢复已移动的原数据；硬断电或无法回滚时保留锁与 transaction.json，启动器会阻止带有未完成导入锁的本地实例启动，应先按备份事务修复，不要删除原数据库或导入锁。

先在服务器核对新端口 `/healthz` 返回 200，后端只监听已配置的回环端口（当前 19501）；再分别从公司有线、`@Ruijie-s7661`、`Unionwell` 对应的实际办公网段访问新端口 4001。确认页面、API、Socket.IO、招聘网站登录、一次授权的简历采集和保存，以及断开远程桌面后继续访问。代理/TUN 环境应让公司地址直连；仅本机健康成功不能代替跨网段验收。

每次升级的 `backups` 是单机业务数据切换恢复点，**浏览器 profile 不属于自动数据回退范围**。可见 Chrome 独立运行，不保证随 Node 停止；维护人员需要另外正常关闭这些 Chrome 窗口，再将完整 shared（含 browser-profiles）、backend.env、delivery 配置和所需 release 复制到公司受控备份位置，并验证恢复。不得在 Chrome 仍运行时覆盖 profile。脚本不会无限自动删除备份或旧 release。正常维护先禁用镜像任务，再使用 `Stop-CompanyRuntime`（dot-source `delivery\Common.ps1` 并读取配置）；恢复使用 `Start-CompanyRuntime`，随后验证 `/healthz`。新数据库的有意破坏性迁移应先独立验证恢复路径。
