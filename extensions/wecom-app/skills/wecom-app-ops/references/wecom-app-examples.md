# wecom-app 常用模板与示例

## 1) 回发入站图片（reply 当前消息）

要素：
- target：通常 `user:<name>`
- replyTo：当前消息 id
- path：入站 saved 路径（inbound/YYYY-MM-DD/xxx）

示例（概念）：
- channel: wecom-app
- target: user:CaiHongYu
- replyTo: <message_id>
- path: /root/.openclaw/media/wecom-app/inbound/2026-02-04/img_xxx.jpg

## 2) 回发录音（.amr）

示例：
- path: /root/.openclaw/media/wecom-app/inbound/2026-02-04/voice_xxx.amr

## 3) README 以“文件形式”发送

步骤：
1. 把 README 内容写入 `/tmp/openclaw-china-README.md`
2. 用 message.send 附件发送

## 4) 发送失败排障

- requires a target：补 target
- Unknown target：改用 user:<name> 或要求提供真实 id
- ok=false：检查文件是否存在/大小限制/通道错误日志

## 5) OCR（MCP）

用 mcporter 调用：
- zai-mcp-server.extract_text_from_screenshot

输入：image_source=/root/.openclaw/media/wecom-app/inbound/YYYY-MM-DD/img_xxx.jpg
