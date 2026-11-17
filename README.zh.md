# dsh-session-todos · 会话待办

给 DeepSeek Harness 的每个会话加一个待办方格，并做一整页的待办面板：**正在做 / 将要做 / 已做完**。

## 功能

- **会话行方格**：侧边栏每个会话行右侧一个小方格。点击 = 完成 ↔ 未完成。
  - 空心 = 将要做；蓝色描边 = 会话正在运行（正在做）；绿色对勾 = 已做完。
  - 会话行右侧的悬停按钮排由 dsh-session-quickbar 接管，它内置的「待办」按钮直接读写本插件的 /session-todos 路由，本插件因此不再向 sidebar.workspaces.session.row.action 注册。
  - 行末 ⋯ 菜单里也有「标记为已完成 / 标记为未完成」，和「重要度…」并列。
- **待办页面**：侧边栏导航「待办」，占满主区域。
  - 三张统计卡片：正在做 / 将要做 / 已做完（含占比）。
  - 三个可折叠分组，默认折叠「已做完」。
  - 每条待办可写备注、设优先级（低/普通/高）、设截止日期；逾期标红。
  - 搜索会话标题、备注、工作目录；可显示已归档会话。
  - 点击标题直接打开会话。
- **AI 工具**：`session_todos`，可 list / set / clear，模型可以在对话里直接更新待办。
- **多窗口实时同步**：Server-Sent Events 推送，任意窗口改了立刻同步。
- **持久化**：数据存于 `~/.dsh/session-todos.json`，重启、换端口都不丢。

## 状态是怎么算的

- **已做完**：方格被勾选（手动）。
- **正在做**：未勾选，且该会话此刻正在运行（自动跟随，不需要手动切换）。
- **将要做**：其余。

勾选优先：一个已完成的会话再次运行，仍留在「已做完」，直到你取消勾选。

## 为什么方格在右边

会话行左侧的格子被应用自身占用：会话运行时显示运行状态点，运行结束后显示完成提醒点。放在左侧的控件会随状态出现/消失，所以方格固定在行右侧（星级左边），始终可见、位置稳定。

## 安装

在 `~/.dsh/profiles/desktop/package.json` 中：

```json
{
  "dependencies": {
    "dsh-session-todos": "link:D:/Deepseek work/workplace/dsh-session-todos"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-session-todos"]
    }
  }
}
```

然后重启 DSH。宿主端注册 `/session-todos`、`/session-todos/events` 与 `session_todos` 工具，浏览器端注册会话行方格、待办页面和侧边栏入口。

## 开发

```bash
npm test          # 宿主端：存储、路由、工具、持久化
npm run test:dom  # 浏览器端：方格三态、点击写入、页面分组
```

浏览器端测试用自带的极简 hooks 运行时直接跑 `client.js`，不依赖 React 或 jsdom。

## 从 GitHub 安装

```sh
dsh plugin --profile desktop add github:879745uhjun/dsh-session-todos
```

装好后刷新 Web 页面。

## 许可

MIT
