# 公司服务器发布与维护

目标入口为 `http://192.168.1.24:4000/`。网关统一提供 React 页面、API 和 Socket.IO；招聘后端仅监听服务器回环地址 `127.0.0.1:5001`。员工连接公司有线或获准的 Wi-Fi 后使用同一个地址，不在员工电脑安装后端。

代码流向固定为 **GitHub 的 main → Gitee 镜像 main → 公司服务器每 5 分钟拉取**。GitHub 是开发源；Gitee 保存同一提交的代码镜像；简历、附件、招聘网站浏览器配置、模型密钥和运行数据只保存在服务器 `shared`，不进入两个代码仓库。

## 服务器目录

默认根目录为 `D:\App\SXF\AutoRecru`。

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

Gitee 仓库预期为 `felixshe/auto-recru-company`，为 GitHub 对应私有仓库设置单向 Pull 自动镜像。镜像完成后核对 main 的完整 40 位提交一致。GitHub 镜像授权、模型密钥均通过对应服务的管理界面保存，不写进脚本。

首次可从 GitHub 或 Gitee 下载该**完整提交**的 ZIP，先校验下载文件 SHA-256，再解压并确认项目文件位于选定源码根目录。下面的源码路径、提交及 Windows 账户按实际值替换：

```powershell
$source = 'D:\App\SXF\AutoRecru-Bootstrap\auto-recru-company'
$commit = '<已核对的40位提交SHA>'
& "$source\deploy\company\Install-Company.ps1" `
  -InitialRepositoryRoot $source -Commit $commit `
  -RunAs '<服务器上已登录的固定Windows账户>' `
  -AllowedNetworks @('192.168.1.0/24','192.168.11.0/24') `
  -OpenFirewall -PrepareOnly
```

`-PrepareOnly` 创建新项目自身任务、部署公钥、依赖与构建，保留旧服务运行。自动镜像部署任务保持禁用。脚本创建的新防火墙规则仅允许这些已确认公司网段到服务器 TCP 4000；若已有同名规则则停止，不覆盖。不同 Wi-Fi 可能属于不同 VLAN，Wi-Fi 名本身不能证明所处网段或路由权限。5001 不向局域网发布。

把服务器 `delivery\gitee-readonly-ed25519.pub` 的**公钥**添加到 Gitee 仓库的只读部署公钥。私钥留在服务器，仅 SYSTEM 和管理员可读。

确认准备完成后，把实测旧任务名和旧目录明确传给切换脚本。示例中的值必须替换；旧监控和备份任务也应按实际配置列入，防止旧服务被重新启动：

```powershell
$root = 'D:\App\SXF\AutoRecru'
$prepared = Get-Content "$root\delivery\prepared-release.json" -Raw | ConvertFrom-Json
& "$root\delivery\Switch-Release.ps1" -InstallRoot $root `
  -ReleaseRoot $prepared.root `
  -LegacyInstallRoot '<已核实的旧招聘项目绝对路径>' `
  -LegacyTaskName @('<已核实的旧服务任务>','<已核实的旧监控任务>','<已核实的旧备份任务>')
Enable-ScheduledTask -TaskName 'AutoRecru-Company-MirrorDeploy'
Start-ScheduledTask -TaskName 'AutoRecru-Company-MirrorDeploy'
```

脚本先验证每个旧任务的工作目录或参数确实引用指定旧目录，再停用这些任务。未知的 4000/5001 监听进程只会导致停止执行，**不会按端口盲目杀进程**。若旧服务是手动窗口、Windows Service 或其他方式启动，先核实并使用其原管理方式正常停止，再运行切换；本脚本不猜测服务名。

## 日常发布

开发者运行相关测试，确认仓库没有简历、密钥和运行目录，提交精确发布内容后执行：

```powershell
& '.\deploy\company\Publish-Company.ps1'
```

该脚本只推送已提交的代码到 GitHub，然后等待 Gitee main 出现相同提交，不自动加入文件或手工覆盖 Gitee。服务器的 `AutoRecru-Company-MirrorDeploy` 以 SYSTEM 身份准备新版本，再启动交互运行任务；构建失败时现有服务继续运行。固定 delivery 脚本不会随 Git 拉取自动覆盖，修改部署机制后应单独审阅并更新服务器 `delivery` 内脚本。

服务器查看状态：

```powershell
Get-ScheduledTask -TaskName 'AutoRecru-Company-*' | Select-Object TaskName,State
Get-Content 'D:\App\SXF\AutoRecru\delivery\last-sync.json'
Get-Content 'D:\App\SXF\AutoRecru\delivery\last-deployment.json'
Get-Content 'D:\App\SXF\AutoRecru\control\current-release.json'
```

首次准备的依赖安装若失败，修正原因后重跑原 `Install-Company.ps1` 命令并增加 `-Resume`。它要求原提交、账户、网段、仓库及运行路径全部一致，验证已有任务与防火墙规则；保留 shared、backend.env 和部署私钥。已有当前版本指针的正式安装不能使用 Resume。也可单独运行 `delivery\Prepare-Release.ps1 -InstallRoot ... -SourceRoot ... -Commit ...`，然后按上文切换。不要删 shared 或重新覆盖真实环境配置来修复安装。

## 验收与恢复

先在服务器核对 `/healthz` 返回 200，后端只监听回环 5001；再分别从公司有线、`@Ruijie-s7661`、`Unionwell` 对应的实际办公网段访问 4000。确认页面、API、Socket.IO、招聘网站登录、一次授权的简历采集和保存，以及断开远程桌面后继续访问。代理/TUN 环境应让公司地址直连；仅本机健康成功不能代替跨网段验收。

每次升级的 `backups` 是单机业务数据切换恢复点，**浏览器 profile 不属于自动数据回退范围**。可见 Chrome 独立运行，不保证随 Node 停止；维护人员需要另外正常关闭这些 Chrome 窗口，再将完整 shared（含 browser-profiles）、backend.env、delivery 配置和所需 release 复制到公司受控备份位置，并验证恢复。不得在 Chrome 仍运行时覆盖 profile。脚本不会无限自动删除备份或旧 release。正常维护先禁用镜像任务，再使用 `Stop-CompanyRuntime`（dot-source `delivery\Common.ps1` 并读取配置）；恢复使用 `Start-CompanyRuntime`，随后验证 `/healthz`。新数据库的有意破坏性迁移应先独立验证恢复路径。
