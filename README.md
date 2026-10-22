# 智能招聘助手（公司内网版）

此仓库保存可部署的最新源代码。通过私有 GitHub 仓库同步到私有 Gitee 仓库，再部署到公司服务器。

完成服务器部署并验收后，公司内网访问入口为 http://192.168.1.24:4000/ 。连接获准的公司 Wi-Fi 或有线网络的同事可在浏览器打开。

部署、运行配置、浏览器采集环境和回滚步骤见 [公司部署说明](deploy/company/README.md)。

简历、数据库、登录会话、模型密钥及邮箱密码均保存在运行环境，不进入此源代码仓库。

发布前检查：`node scripts/audit-release.js --index`。从开发项目刷新此快照：`node scripts/prepare-company-release.js --destination <公司版目录> --refresh`。
