# 通过 helmod 生成蓝图：现状、问题、要改成的样子

（2026-10-05 晚，玩家实测两轮之后写的。新会话从这里接手，别从记忆接手。）

## 0. 玩家这两轮实际说的是什么

1. 「红板三种原料，进料的传送带只有一条」→ 形状只有 1 条进料带，第 3 种料没地方来。
2. 「就算出料带同时进料，机械臂也不够，下面没有进料机械臂」→ 他说的是几何硬约束：一台机器要摸到每种料，就得有对应那一面的臂。
3. 「为啥两台组装机中间放一个机械臂和一个箱子」→ `two-feed` 把两条带子都花在进料上，产品没有带子可走，只能每机一臂一箱，箱子站在过道里。
4. 「自动也不对」→ 一半是第 3 点；另一半是面板「形状」那格被钉住（见 §2 的 `7731`），"自动"没走到。

结论：**三种料的线，现在四种形状里没有一个能用。** 不是在旧形状里挑一个的问题。

## 1. 现在的链路（调用顺序，带行号）

```
面板 / RCON
  └─ M.helmod_factories        control.lua:7427   列 helmod 的工厂页
  └─ M.helmod_ghosts           control.lua:7508   ★ 主入口：一页 → 若干条线 → 虚影 / 蓝图 / 拿到手上
        local named_style = args.style ~= "" and args.style or nil       -- :7731
        materials = #recipe_needs(r.recipe)                              -- :7631
        build_with(m):  ladder = named_style and { named_style }         -- :7754
                             or shape_ladder(m, materials)
                         → M.card_example{recipe, machine, machines=m, style=want, ...}
        拆行： per_line = feed_plan.machines_per_line，再被 ground_width 掐一次  -- :7849-7872
        出件： blueprint_item / blueprint_string → hand_blueprint（手 / 背包两道门） -- :7791-7860
  └─ M.helmod_blueprints       control.lua:8122   ★ 发的是"已冻结的卡"，不是新算的线
```

形状本体在 `src/architect/styles.lua`：

| 形状 | 铺了什么 | 三种料能不能用 |
|---|---|---|
| `row-chest` | 每机一进料箱 + 一出料箱，一条短进料带 | ✗ 头部只喂 1 种 |
| `row-belts` | **1 条进料带 + 1 条出料带**，每机 1 进臂 1 出臂，产品上带 | ✗ 一条带只有 2 个半股 |
| `two-feed` | **2 条进料带（南北面各一）**，每机 2 进臂；产品走"每机 1 出臂 + 1 出料箱"（过道列） | 料能喂齐，**箱子不可接受** |
| `sandwich-2` | 两排机器共用 1 条产品带，两条外带各自喂自己那排的 2 个半股 | ✗ 一台机器只摸到 1 条进料带 |

已有的、这轮改对的东西（别回退）：

- `shape_ladder(n, materials)`（`control.lua` 顶部，现已提为文件级共用）：`materials>2 → {two-feed,row-belts,row-chest}`。
- `card_example` 的默认形状会**先看铺下来的形状实际送到几种料**（`unfed`），送不齐就按阶梯重画，且**只接受真的让缺料变少**的那次搬家；点名不换（`shape_moved={from,to,because}`）。
- 臂按需：`arm_ladder_for_need` + styles 的 `min_reach`；同段并列里现在优先 `fast-inserter`（`ARM_WORKHORSE`），没有才按配方料数（`arm_cost`）取最省；喝流体的线自动要 reach 2。
  - 注意：2.0 原型上 `energy_per_movement`/`fuel_inventory_size`/`stack_size` **全部 raise**（实测），所以"谁快/谁烧煤"只能靠量臂；纯按料数会选出烧煤臂，是反例，注释里写着。
- `heads = "belt"`（0.60.22）：去掉头部箱子，改立一块牌（`decider-combinator` 当发射器 + `display-panel`，一根绿线）。
  - **常量组合器不能用**：2.0 删光了它可写的键，且手写它的 `control_behavior` 会在**存档时**踩引擎断言打死服务器（`dev/circuit_blueprint_emit.js` 顶部）。
  - 一条带 = 2 个半股，所以 `row-belts` 的牌最多写 2 道（这个上限是 `belt_head_e2e`/`layout_ledger` 的断言）。
  - 裸带头没有 in-port，`card_lab` 现在按名拒 `CARD_NO_PORTS`，不会量出一条空线报 0。

## 2. 要改成的样子（六条，按依赖排序）

1. **先算流量，再定带子**。需要的进料带数 = `⌈料种数 / 2⌉`；产品必须走 1 条带（用 `lane_of(item,belt).per_min` 对 机器数×产物/分 验）。带子数量是**算出来的**，不是形状自带的属性。
2. **每机臂数 = 摸得到的进料带数 + 1（产品）**，摆不出那一格空地就加过道，加不出来就**按名拒并说原因**。目标排法：`two-feed + 1 条产品共带` = 每机 3 臂、**0 只机器级出料箱**。这就是缺的那一档，建议命名 `three-line`。
3. **线上不留箱子**：头部箱子已由 `heads:"belt"` 去掉；机器级出料箱被产品带替掉。只有玩家明确要 filter/overflow 时才出现箱子。
4. **形状是偏好，不是许可**：`7731` 那条"点了形状就跳过阶梯"要改成 —— 点名的形状喂不齐/装不下产品时落回算出来的那个，并写 `style_overridden={asked,used,because}` 到那条线和面板行。
5. **超载加分带，不加分箱**：一行超过一条带的 `per_min` 时，加的是同向的第二条带。
6. **可疑就当场拒**：页宽截线（已修）、料没道（§2.4 待修）、臂够不着（已修）、空线量出 0（已修）。

## 3. 接手时的待办状态

- **未提交**：`dev/layout_ledger.js`、`src/architect/control.lua`、`src/architect/info.json`、`src/architect/styles.lua`（版本串已成 `0.60.24`，`mods/architect_0.60.24.zip` 在 27015 上跑着）。里面是：形状按料数 + 牌道数封顶 + 重画只认真减少 + 裸头从阶梯起步 + 臂改高速档；新断言 10 条写在 `layout_ledger.js`，**全套门禁未跑**。
- **门禁要切服务器**：`bash dev/test.sh bash dev/regress.sh`（会停 27015 起 27016）。**别并发跑两套** —— 这一轮我又犯了两次，红了全是假的。
- 任务：#52 线头去箱+标牌（做了一半，默认仍是箱头，`heads` 还没通到压线和面板）、#53 标牌真亮（幽灵建的实体带不带电路内容，未证；`circuit_wire_e2e` 记着幽灵的线建好就没了）、#31 农场台架整轮里塌、#45 facing/power 预热。
- 存档事实：27015 实际读的是 `.factorio-data/saves/m0.zip`（不是 m0-prep.zip），玩家这台的科技我已全开并 `/save` 落盘。RCON 存盘命令是 `/save`，不带斜杠的 `save` 是空响应。
- 工作区怪事：本轮出现过"文件多了我没写的改动"（22:13 `styles.lua` 多出正确的 8 行）和更早的"我写的改动从磁盘消失、只有服务器内存里有"。玩家说仓库只有我在管 → 很可能是**两个我的会话**（手机 CLI + remote-control）同时在写同一个工作区。接手第一件事：`git diff` 落底，别信记忆。
