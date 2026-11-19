# 会话提醒与待办 · 设置面板示例

> 状态：**示例稿（mockup）**，未接入生产 UI。等用户点头后再按本稿实现。
> 入口设想：插件详情页 / 设置面板里的「提醒与待办」区域，待办项来自本插件，提醒项来自 `dsh-session-notify`。

## 两张图

| 图 | 场景 | 文件 |
| --- | --- | --- |
| A | 装了 `dsh-session-notify`：待办 2 项 + 提醒 3 项 | `shot-a-notify.png` |
| B | 没装：只剩待办 2 项，屏幕上不出现「提醒」字样 | `shot-b-no-notify.png` |
| A（浅色） | 同一面板的浅色主题 | `shot-a-light.png` |

单文件源码：`session-settings.html`。参数：`?notify=0` 隐藏提醒区块，`?theme=light` 浅色，`?nav=0` 隐藏顶部切换条（出图用）。

## 每一行

| 行 | 作用 | 作用域 | 保存位置 / 路由 |
| --- | --- | --- | --- |
| 待办自动关注 | 勾成待办时自动关注该会话，跑完弹卡；完成/清除只取消本插件建立的关注 | 全局默认 | `session-todos.json · autoWatch` → `GET/POST /session-todos/settings` |
| 会话重新开工时取消完成 | 会话重新开工时把已勾选的待办重置为未完成，并因此重新触发自动关注 | 全局默认 | `session-todos.json · reopenOnResume` → 同一路由 |
| 结束时提醒我 | 这个会话跑完一轮就提醒；不勾则不为它建提醒 | 当前会话 | notify 的 watch 表 → `POST /session-notify/watch { sessionId, on }` |
| 提醒方式（一次 / 每次） | 一次：提醒一次就结束；每次：一直提醒直到你处理（打开会话或手动关） | 当前会话 | `POST /session-notify/mode { sessionId, mode: 'once' \| 'always' }` |
| 新会话默认值 | 新建会话时的默认「是否提醒 + 方式」，已有会话不受影响 | 全局默认 | notify 侧保存（具体键待回执确认） |

## 提醒是可选功能

- 打开面板时探测 `GET /session-notify`（**1.5 秒**超时）：只有 200 才渲染提醒区块；
- 404 / 超时 / 坏 JSON → **整块不渲染**（不灰显、不占位），待办功能照常；
- **每次打开都探一次**，不缓存「已安装」结论（用户可能中途装/卸）；
- **数据所有权**：提醒相关读写全部走 notify 的路由；todos 不存 mode、不写它的文件。

## 待确认（等 notify 回执）

1. watch 条目里表示方式的字段名（`mode` 还是别的）；
2. 「新会话默认值」存在 notify 的哪个键 / 哪个路由；
3. `POST /session-notify/mode` 对尚未 watch 的会话是否隐式建立 watch。

对不上字段名我会先回报，不猜。

## 重新生成截图

```sh
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
BASE="file:///D:/Deepseek%20work/workplace/dsh-session-todos/docs/mockups/session-settings.html"
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot=shot-a-notify.png --window-size=760,900 "$BASE?notify=1&theme=dark&nav=0"
python crop_shots.py shot-a-notify.png
```
