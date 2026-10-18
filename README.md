---
domain: education
tags:
  - academic-presentation
  - education
  - large-language-model
sdk: docker
app_port: 7860
---

# 求是·智汇

校园学术汇报 AI 工作台。上传论文、Word、PPT、文本或图片，结合汇报场景生成初稿，逐页编辑并导出可编辑 PPTX。支持自有 PPTX 模板的字体、配色与页面尺寸提取，以及 PDF 逐页图文理解、原图裁剪、来源与讲稿保留。

这是供 GitHub 与魔搭创空间部署的独立版本，复用现有工作台和生成流程。Node.js 24、SQLite 与本地对象存储替代 Sites 专属绑定；不依赖托管登录请求头。

## 本地运行

```bash
npm ci
npm run build
npm start
```

打开 `http://localhost:7860`。首次访问创建带签名的独立工作区 Cookie。不同浏览器的素材、项目与个人模型配置分别保存，不能通过公开请求头指定其他工作区。清除 Cookie 后无法自动找回原工作区，请及时下载项目备份。

## Docker 与魔搭创空间

```bash
docker build -t qiushi-presentation-studio .
docker run --rm -p 7860:7860 -v qiushi-data:/mnt/workspace qiushi-presentation-studio
```

创空间选择 Docker，使用仓库根目录的 `Dockerfile`，服务端口为 `7860`，启动命令为 `node runtime/launch.mjs`。`/healthz` 提供健康检查。Docker 默认将数据保存在魔搭提供的持久目录 `/mnt/workspace/qiushi`，包括工作区签名密钥、模型加密密钥及项目。启动器创建并授权该目录后，降为 UID/GID 1000 运行应用；不会在镜像构建期间向运行时挂载目录写入数据。本地 `npm start` 默认使用当前目录下的 `data/`。

默认不附带任何团队模型密钥。访问者可在“管理模型”添加自己的 OpenAI 兼容 HTTPS 服务；密钥使用 AES-GCM 加密保存，不回传浏览器或写入项目备份。管理员也可在创空间的私密环境变量中设置 `MODEL_API_KEY` 启用平台默认模型。

| 环境变量 | 说明 |
|---|---|
| `PORT` | 默认 `7860` |
| `DATA_DIR` | SQLite、上传对象、工作区签名与加密密钥目录 |
| `PUBLIC_URL` | 最终 HTTPS 站点地址；宿主修改 Host 时填写 |
| `MODEL_API_URL` | 默认 `https://api.deepseek.com/chat/completions` |
| `MODEL_NAME` | 默认 `deepseek-flash`，界面显示 `DeepSeek-V4.1-Flash` |
| `MODEL_API_KEY` | 可选的平台模型私密密钥 |
| `MODEL_MAX_INPUT_CHARS` | 默认 `400000`，允许 `80000–1000000` |
| `MODEL_MAX_OUTPUT_TOKENS` | 默认 `16000` |
| `MODEL_BACKUP_API_KEY` | 可选；仅明确额度不足时重试一次 |
| `SESSION_SECRET` | 可选，至少 32 个随机字符；缺省生成并保存在 `DATA_DIR` |
| `MODEL_CONFIG_ENCRYPTION_KEY` | 可选，32 字节随机值的标准 Base64；缺省生成并持久保存 |

如使用 `.env`，运行时可使用 `node --env-file=.env dist/server.mjs`；容器环境请使用平台私密变量。不要将真实密钥提交仓库。

## 已发布样片与范围

公开部署仅包含课程、组会及文献分享的三份学术样片，目录和文件接口均按白名单开放。两份个人答辩汇报、其缩略图、原始文件与下载路径均不包含在本版本。样片以完整只读 PDF 预览，不提供 PPTX 或原件下载接口；只读权限用于减少误编辑，不等同于防复制。

单文件最高 200 MB，8 MB 分块上传，PDF 与 Office 最多处理 300 页；生成最多 24 页，每个工作区每天最多 20 次。PDF 图文读取仍需所选模型具备图像输入能力；平台模型的可用能力以实际接口响应为准。复杂母版、校标对象与动画不完整迁移，导出后请在实际演示软件核对。

网页字体和品牌资源沿用用户提供的项目素材，来源见 `public/fonts/SOURCES.md`；相关资源不额外授予独立再分发许可。生成规范快照位于 `server/skill-source`。

## 验证

`npm test` 验证真实 HTTP 服务、签名工作区隔离、伪造请求头拒绝、跨来源写入拒绝、模型密钥加密、文本与 PPTX 提取、项目保存与 PPTX 导出、三份学术样片及个人答辩路径排除。测试使用合成材料与密钥，不调用外部模型。
