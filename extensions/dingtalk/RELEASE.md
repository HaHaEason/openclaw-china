## 构建

```bash
pnpm -F @openclaw-china/dingtalk build
```

## 发布

- 不带版本号递增的发布：
```bash
pnpm -F @openclaw-china/dingtalk release
```

- 带版本号递增的发布：
```bash
pnpm -F @openclaw-china/dingtalk release:patch
pnpm -F @openclaw-china/dingtalk release:minor
pnpm -F @openclaw-china/dingtalk release:major
```
