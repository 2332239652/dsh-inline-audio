# dsh-inline-audio 对话内联音频

让 DeepSeek Harness 的对话**直接播放本地音频**:LLM 回复中输出的本地音频路径(`C:\...` 盘符、UNC、POSIX、`![](本地路径)`、反引号包裹)会在**消息正文里**自动渲染成可播放的 `<audio>` 播放器——不再只是一串看不到的路径文本。

## 功能

- **消息正文内联播放**:扫描助手回复文本中的本地音频路径,把真实存在的音频文件改写成同源回环 URL,配合 client 端把占位替换成 `<audio controls>` 播放器,点播放即可听。
- **支持格式**(14 种):wav / wave / mp3 / ogg / oga / m4a / aac / flac / opus / webm / weba / mp4(音频轨)/ mid / midi。
- **HTTP Range 支持**:实现 206 Partial Content + Content-Range,拖动进度条/跳播正常。
- **安静降级**:不存在的路径、示例/占位路径(路径、xx、... 等)静默跳过,不影响对话;流式文本仍是纯文本 URL,纯文本模型适配器不会拒绝。
- **上限**:单个音频最大 200MB。

## 构建与安装

从源码（clone 本仓库后）:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add ./dsh-inline-audio
```

装完后重启 `dsh web`(或启动器里重启 Web 服务),硬刷新浏览器(Ctrl+Shift+R)。

> 也可通过 `dsh plugin --profile web add 2332239652/dsh-inline-audio` 直接从本 GitHub 仓库安装。

## 工作原理

1. `llm/stream` 事件钩子包装文本流,`fs.resolve` + `fs.stat` 确认音频文件真实存在。
2. 按原始区间把路径替换为 `![audio](http://127.0.0.1:<port>/plugins/dsh-inline-audio/audio?t=<token>&p=<path>)`。
3. 官方 Markdown 渲染器把它渲染成 `<img>` 占位。
4. client 端 MutationObserver 发现 `img[src*="/plugins/dsh-inline-audio/audio"]` → 原地替换成 `<audio controls preload="metadata">`。
5. webServer 路由校验 token 后读取文件字节,按 Range 头切片返回(206/200)。

## 注意事项

- 只处理本地绝对路径;HTTP(S) 音频、data URI、file: 链接、相对路径不会处理。
- token 每次激活随机生成;插件重新加载或 Harness 重启后,旧消息里的回环 URL 可能失效(重新输出路径即可)。
- 以当前 dsh 进程权限读取本地文件,安装前请审阅源码。

## 许可证

MIT