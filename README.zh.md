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

**勾选之后会发生什么：** 默认是**显式勾选优先**——会话重新开工不会改变你的勾选。开启「会话重新开工时取消完成」后，重新开工会把 done 重置为未完成（只在该会话从「不在运行」变为「运行中」的那次跳变生效），并因此重新触发自动关注。

这个开关**默认关闭**，而且不追溯：窗口打开时已经在运行的会话不会被清掉，历史上已有的已完成项也不会被补改；开启后再勾选，要等该会话下一次重新开工才会再变回待办。

## 与 dsh-session-boxes 的联动

装了 `dsh-session-boxes` 时，待办页面按盒子重新组织（**只读**：同源 `GET /session-boxes`，不 import 它的代码，也不读它的 JSON 文件）：

- **分组**：每个盒子一组，子盒显示为 `父 › 子`，组头前有盒子颜色点；未分组的待办固定在最后；
- **组头统计**：右侧显示 `未完成/总数`（例如 `2/5`），悬停提示「未完成 2/5」；
- **筛选 chip**：`全部` / `未分组` / 各个盒子（带数量）。点父盒会包含它的所有子盒；盒子为空时不显示；
- **组内排序**：沿用原来的顺序（正在做 → 将要做按优先级/截止 → 已做完按完成时间）。

**降级行为**：盒子路由 404、超过 1.5 秒未响应、或 JSON 解析失败时，页面自动退回原来的「正在做 / 将要做 / 已做完」平铺列表 —— 不弹错、不阻塞。行尾方块、⋯ 菜单、SSE 同步、存储格式与 `/session-todos` 契约都不受影响。盒子插件后装也不用重启：每次打开待办页都会重新读一次。

## 与 dsh-session-notify 的联动（待办自动关注）

装了 `dsh-session-notify` 时，待办页头部会出现「待办自动关注」开关（**默认关闭**，偏好存在 `~/.dsh/session-todos.json` 的 `autoWatch` 里）：

- 开启后，把一个会话标成待办（未完成）→ 自动 `POST /session-notify/watch {on:true}`，这一轮跑完就会弹卡；
- 标成完成、或清除待办 → 只取消**本插件自己建立**的关注：文件里的 `autoWatched` 记录所有权，用户手动关注的不动；
- 关闭开关时会释放所有本插件建立的关注；
- 只在状态变化时发请求：同一会话串行、幂等，不会重复 watch；失败也不重试轰炸；
- **降级**：notify 路由 404、超过 1.5 秒未响应、或返回坏 JSON → 静默跳过，待办本身照常保存；没装 notify 时这个开关整体不出现；
- **不追溯**：打开开关不会给已存在的待办补 watch，只对之后的状态变化生效。

## 会话重新开工时自动取消「已完成」

**默认关闭**，需在 Todo 页头部开启。

会话从「空闲」变为「正在工作」时，它那条已完成的待办会自动取消勾选，让列表回到实际状态：

- 客户端监听会话目录，只在**假 → 真**的这次转变时触发；窗口打开时本来就在运行的会话不会被清掉（保留你离开时的状态）；
- 写入走正常的 `/session-todos` 路由，所以其它窗口经 SSE 一起更新；如果开了「待办自动关注」，重新变回待办的会话也会自动重新关注；
- 没有待办、或待办本来就未完成的会话不受影响。

## 与 dsh-notepad 的联动（行内有笔记标记）

装了 dsh-notepad（4.4.0+）时，凡是已有会话笔记的待办行，标题右侧会出现一个小笔记图标，点它直接打开那条笔记：

- 只使用它公开的客户端协议 `window.dshNotepad`（`version: 1`）：`listSessionNotes()` / `openSessionNote(id)` / `subscribe()`；不读它的 localStorage，也不 import 它的代码；
- **没有笔记的行不占位**、不显示图标；
- 笔记落盘后通过 `subscribe` 回调重新读一次列表，刷新对应行的标记；页面卸载时取消订阅；
- **降级**：`window.dshNotepad` 不存在、`version !== 1`、或任一调用抛错 → 全部不显示图标，待办功能照常可用，不阻塞加载。

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

## 发布（维护者）

正常路径就是真 `git push`。若 push 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，先看凭据助手是不是空的（`git config --get credential.helper` 无输出即为空），这**不是机器不支持**：

```sh
git config --local credential.helper '!gh auth git-credential'
git push origin main
```

推完用 API 自证远端（本机 `ls-remote` 偶发不稳，API 通道稳定）：

```sh
gh api repos/879745uhjun/dsh-session-todos/git/ref/heads/main --jq '.object.sha'
```

只有在当前环境确实无法认证时，才退回 REST 备用路径（token 只从 `GITHUB_TOKEN` 读，不落盘）：

```sh
GITHUB_TOKEN="$(gh auth token)" REPO=879745uhjun/dsh-session-todos DIR=. \
  COMMIT_MESSAGE="feat: …" node tools/publish.mjs
```

## 许可

MIT
