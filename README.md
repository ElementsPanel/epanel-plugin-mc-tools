# epanel-plugin-mc-tools

适用于 ElementsPanel 的 Minecraft 工具插件，支持 Java 版和基岩版服务器状态查询、地表地图查看及玩家管理。

## 地图隐藏玩家

Java 实例内的玩家可在游戏聊天栏发送以下指令，控制自己是否出现在地图上（含公共地图页面）：

- `$mapos off`：不再显示在地图上
- `$mapos on`：恢复显示

状态按实例保存在面板 daemon 的实体存储里（`daemon/data/McToolsMapVisibility/hidden-players.json`），重启面板或服务器后仍然有效。指令生效后会通过 RCON（未开启时退回服务器控制台）用 `tellraw` 私信该玩家确认。
