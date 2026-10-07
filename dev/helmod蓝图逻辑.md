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

（2026-10-06 更新过一次：下面第一段写的 0.60.24 已成历史，现在是 **0.60.25**，全量门禁 33 套绿，见 §4。）

- **曾未提交**：`dev/layout_ledger.js`、`src/architect/control.lua`、`src/architect/info.json`、`src/architect/styles.lua`（版本串已成 `0.60.24`，`mods/architect_0.60.24.zip` 在 27015 上跑着）。里面是：形状按料数 + 牌道数封顶 + 重画只认真减少 + 裸头从阶梯起步 + 臂改高速档；新断言 10 条写在 `layout_ledger.js`，**全套门禁未跑**。
- **门禁要切服务器**：`bash dev/test.sh bash dev/regress.sh`（会停 27015 起 27016）。**别并发跑两套** —— 这一轮我又犯了两次，红了全是假的。
- 任务：#52 线头去箱+标牌（做了一半，默认仍是箱头，`heads` 还没通到压线和面板）、#53 标牌真亮（幽灵建的实体带不带电路内容，未证；`circuit_wire_e2e` 记着幽灵的线建好就没了）、#31 农场台架整轮里塌、#45 facing/power 预热。
- 存档事实：27015 实际读的是 `.factorio-data/saves/m0.zip`（不是 m0-prep.zip），玩家这台的科技我已全开并 `/save` 落盘。RCON 存盘命令是 `/save`，不带斜杠的 `save` 是空响应。
- 工作区怪事：本轮出现过"文件多了我没写的改动"（22:13 `styles.lua` 多出正确的 8 行）和更早的"我写的改动从磁盘消失、只有服务器内存里有"。玩家说仓库只有我在管 → 很可能是**两个我的会话**（手机 CLI + remote-control）同时在写同一个工作区。接手第一件事：`git diff` 落底，别信记忆。
- 2026-10-06 夜的状态：玩家把服务器与代码全交给我管，并加了一条要求——helmod 生成蓝图**每一步的判断与生成逻辑都要打成日志**，出问题他能指到哪一步的逻辑不对（任务 #2，下一个动它）。上面那条"未提交"已经落地：0.60.24 的改动 + §4.3 的臂档修复 + §4.4 的两处门禁加固一起进 **0.60.25**，全量门禁 33 套绿。27015 从 00:06 起没开（它自己正常退出，存盘已写回 `m0.zip`），等玩家要实测时再起。

## 4. 2026-10-06 夜：量到的几何与 2.0 API（`dev/belt_stack_probe.js`，台架在 arch-lab 的 7500 角）

这一节把 §2.2 那个"两条进料带 + 一条产品共带"的写法**换成量到的形状**。玩家的要求是"箱子一只不留 + 线头一块牌写清哪条带哪一道"，所以下面每一条都是围着"没有箱子还能不能生产"量的，不是围着好看。

### 4.1 臂的取放规律（四条对照，全过）

| 相 | 台架 | 读数 |
|---|---|---|
| A1 | reach 1 的臂 + 落点箱按距离 1、2 各一只，近带铁板 / 远带铜线 | 距离 1 那只箱收到 `iron-plate=25`，距离 2 那只全程空 |
| A2 | reach 2 的长手，同上 | 只往距离 2 那一格放，送的是**远带**的铜线 34 件 |
| B | reach 2，两种料对调（近带铜线 / 远带铁板） | 照旧只送距离 2，送的是铁板 → **挑的是距离，不是物品** |
| C | 机器 + 同一面两只混档臂（`fast-inserter` 喂近带、`long-handed-inserter` 喂远带），成品走另一面的带子 | 60 秒做出 `electronic-circuit=28`，机器手里还压着 5 件，两个源箱按 1:2.7 掉料 —— **零箱子** |

结论（这就是 #6 供给侧的式子，不是我推的）：

- **一只臂只喂一条带行**，取和放都发生在"距离 = 它的 reach"那一格。所以"一个面能叠几条进料带"= 这个安装里**互不相同的臂 reach 档数**（香草：1 和 2 两档 → 2 条），不是我以为的 `2R`，也不是"一面一条"。
- 落点那一格必须在机器里 → **带行距离 ≤ 机器深度 fh**（3 格高的组装机：距离 1、2 都在机身内 ✓）。
- 于是无箱线一台机器能吃的料种上限 = `2 × min(可用的 reach 档数, fh)` = 香草 **4 种**；成品带同理占另一面，多产物在那一面里分股。
- **成品不能出现在进料那一面**：相 D 里远带换上"这台机器不吃的成品"，对照与试验产出都是 18（因为近带那只臂照常喂），但远带 72 件里只有 1 件离了带子、机器进料仓是空的 —— **那只臂抓到一件就永远卡在那一件上**。所以这条规矩的代价不是停产，是那条带子永久瘫掉 + 成品被吞。
- 两条叠带的头不能都摆在机器列里（臂带只有一格，头部臂要站在带子的另一侧），所以线头只能是**裸带尾让玩家接总线**（`heads="belt"`）或站在机器列以西的列 —— 这给 §2.3 的"去箱"补了几何理由，不只是审美。

### 4.2 2.0 读不到的东西（每条都花了一次失败，别再试）

- 带子**不能用脚本装料**：`belt.insert{name,count}` 回 0 且不报错，两半股 `get_item_count` 全是 0（静默空操作）。`LuaTransportLine` 上没有 `insert`/`can_insert`/`remove`。喂料只能"源头箱 + 头部臂"。
- inserter 上**没有 `can_reach`**（`LuaEntity doesn't contain key can_reach`）。"够不够得着"只能靠放真东西、数它送出去什么。
- 组装机：`entity.recipe` 这个键**不存在**（读用 `get_recipe()`；用 `.recipe` 只会让 pcall 把"读不到"说成 `recipe=nil`，我第一次就是这么误判成"配方没设上"）；没有 `queue`（读到直接 raise，整块 chunk 报错，那一相什么都没量到）；写配方是 `set_recipe(名字)` —— **第二个参数是 by_product**，传 `true` 会静默设不上配方，机器空转，看着像"臂喂不进去"。
- 臂的烧炉身份：**原型侧 `energy_source` / `fuel_inventory_size` / `fuel_categories` / `energy_per_movement` / `inserter_length` 全部 RAISE**，实体侧 `energy_source` 也 raise；只有 `entity.burner` 答话 —— 烧煤档给一个 LuaBurner，电动档给 nil。这就是 §4.3 那个修复唯一的凭据来源。
- 半股旗子：`pickup_from_left_lane` / `pickup_from_right_lane` 在臂上默认都是 true，而 `lane_split_probe` 已证它们**进不了蓝图**。所以"哪种料走哪一道"只能靠几何（哪一面的哪一格）表达，牌上写的编号必须是那个几何的真名。

### 4.3 0.60.24 那份未提交改动里量出来的一个真 bug（已修）

`arm_ladder_for_need` 里"同 reach 里选最省材料的"这一档，在 `fast-inserter` 没研究时把**烧煤臂**选中了（它配料 2 件，是全场最便宜）。门禁把它抓成 `player=burner-inserter`（玩家有科技、敌方势力没有，两边给出同一只烧煤臂）。修法按 4.2 的凭据：在同 reach 组里**先按"烧不烧炉"排**（`arm_is_burner`，读 `entity.burner`，缓存在 `proto_facts` 的 `burner|<name>`，复用 `inserter_reach` 已经放的那只探针 —— 动世界的次数一条没加，boot 的 `warm_reach` 顺带全量好），烧炉档排到最后；真的只剩烧炉档时把它写进 `decided_by` 并回 `burns=true`。

### 4.4 门禁本身的两处加固

- `dev/smoke.js` 把 292 条读数攒到最后才印，而它在最后一行崩了（`card_freeze` 被拒时返回里没有 `data`，断言却去读 `fz.data.blueprint`），**崩溃还发生在它已经"把科技设成自己那份名单"之后**，于是后面 28 套跑在残缺世界上，`NO_AVAILABLE_PART` 那批红全是假的。现在 `report()` + `uncaughtException` 兜底：先把已收到的读数全印出来，再把崩溃本身记成一条 FAIL。"`node --check` 过"不等于"这套会跑完"。
- 新的 `dev/belt_stack_probe.js` 里有一条加载期自检：PRELUDE 必须真的带上它最后一行那个 Lua 函数。反引号会提前结束 JS 模板字符串，而截断后的 Lua 当 JS 读**仍是合法语法**（`BXBYM0ARMBNEARFARRUN.queue` 那种属性访问要到运行时才炸），本轮在这上面栽了三次。Lua 注释里不许出现反引号。

### 4.5 下一步（#6 起）要用的式子

```
每股运力        per_lane = belt 档实测 items/min / 2                （已有：lane_of / feed_plan）
料占几股        lanes_wanted = Σ_每种料 ceil(每分钟胃口 / per_lane)  （已有）
需要几条进料带  feed_rows = ceil(lanes_wanted / 2)
成品占几股      product_lanes = Σ_每种产物 ceil(每分钟产出 / per_lane)  ← 要补：现在只算第一个非流体产物
需要几条成品带  product_rows = ceil(product_lanes / 2)
供给            rows_per_face = 本安装里互不相同的 reach 档数（且 ≤ fh）
判决            feed_rows ≤ rows_per_face 且 product_rows ≤ rows_per_face → 铺得出
                否则按绑住的那一项按名拒（带子太慢 / 臂档不够 / 只能切线）
```

`shape_ladder(n, materials)` 降级成"预设"，不再是唯一的入口。

## 5. 2026-10-06：逐步判断日志已经在了（`helmod_ghosts` 每一步一行）

玩家加了一条要求：helmod 生成蓝图时**每一步的判断与生成逻辑都要打成日志**，出问题时他能说清是哪一步的逻辑不对。现在在了，四处读得到：

- 答案里的 `steps`（编号从 01 连续往上，每行带着**它用的数字**，不只带名字）；上限 400 行，截断老实写 `steps_dropped`。被拒的答案也带（`detail.steps`），整计划那按每页各带一套。
- 服务器日志：每行前缀 `arch-helmod-step`。**注意它落在 write-data 的 `factorio-current.log` / `server.out` 里，不在 `dev/call.js` 读的那份 `server-console.log`**（实测，别照抄那个路径）。
- `helmod_last_steps`：回看上一次压线，不重跑。可点名要哪一页，指错页按名拒 `NO_STEPS` —— 这条同时也是 `dev/refusals.js` 要的那个 fixture：一个码不能只靠"到不了"的名单活着。
- 面板那一格还没接，和 #8（`heads` 通到压线与面板）一起做，免得动两次 gui.lua。

一次红板×4 的真实输出（就是现在这一版）：

```
01 入口 :: 地面 · force · 页 · 排法 · 线头 · 落到 · 拆线 · 允许宽度 · 间隔 · 带/臂/箱点名
02 读页 :: 来源 · 件数 · 配方行数 · 信标 · 清单
03 配方 :: 计划里点的机器 · 要造 · 料种数 · 每次工艺吃=plastic-barx2 copper-cablex4 electronic-circuitx2
04 形状候选 :: 点名 · 料种数 · 阶梯=two-feed → row-belts → row-chest
05   试 <shape> :: 结果=接受/拒 <code> · footprint
06 线卡 :: 形状 · 宽高 · 带/臂/机器/箱 · 臂档+reach · 一台够得着的进料股 · 料共要几股 · 进料带条数
          · 每股运力/分 · 最重一种料/分 · 一行可喂台数 · 需要几条线 · 带太慢 · 成品线每分可走
          · 成品线占用比 · 超载在(带子/臂/都不绑) · 缺料 · 搬形状 · 模型自己的话
07 拆线 :: 要造台数 · 带子喂得动 · 地宽放得下 · 一条线定成 · 会拆成几条
08 落一条线 :: 台数 · 形状 · 放在=x,y · 占=WxH · 实体 · 带/臂/机器/箱 · 缺料 · 喂它的料
09 落件 :: 虚影 · 种类 · 生产线 · 没铺成线的行 · 跳过 · 件数
10 出件 :: 字节 · 实体 · 引擎回读（少件写 short_by）· 交到手/背包时另有门与保留情况
```

第 06 行已经把 §2 的靶子摊开了：**箱=8**（3 只线头 + 4 只机器出料 + 1 只 overflow）、**成品线每分可走=nil**（`two-feed` 压根没有成品带）。#6/#7/#8 就是冲这两个数字去的。

门禁：新增 `dev/helmod_steps_e2e.js` 20 条（编号连续、每步带数字、真 helmod 页与整计划都走同一条链、日志 grep 得到、回读一致、指错页按名拒），登记进 `dev/regress.sh` 的套件表与 `dev/refusals.js` 的扫描名单。`steps_new` / `step()` 是**后续每个新逻辑继续往里写**的地方 —— #6 的 derive、#7 的新形状、#8 的去箱，输入输出都走这个 sink，不要再新造第二套日志。

## 6. 2026-10-06：线计划算出来了（`card_example` 回 `lane_plan`）

#6 落地的东西，一句概括：**"这条线要几条带"现在是算出来的，并且和"这个形状实际铺了几条"并列摆着**。

- 需求侧：`feed_rows_needed = ceil(lanes_wanted/2)`；`product_rows_needed = ceil(product_lanes/2)`，
  其中 `product_lanes` 对**每一个固体产物**求和（从前只认配方里第一个非流体产物）。
- 供给侧：`arm_reach_tiers(force)` —— 这个势力能放的臂里**互不相同的 reach 档数**，`rows_per_face = min(档数, fh)`。
  出处是 §4 量到的规律：一只臂只喂"距离 = 它 reach"那一行带子。
- `short_feed` / `short_product`：这个形状**没铺够**几条（换形状有救）。
- `beyond_any_shape`：需要的带行数超过一个面叠得起的上限（换形状没用，只能切线或换更快的带子）。
  这两种故障分开写，因为下一句建议完全不同 —— 混成一句"这形状不行"就会给错方向。
- `chests_by_role`：箱子按种类数出来（`in` 线头 / `out` 机器级出料 / `overflow` 末端），`chest_free` 要求
  **实铺够**且**一只箱子都不剩**。只说"还有箱子"不说哪种几只，#8 就没法知道该动哪个形状。
- 第 06 步（线卡）把这些数字全打进日志，`layout_ledger` 新加 8 条断言（其中一条明说"今天四个形状
  没有一个能真的无箱"，并写明这条要在 #7 铺出参数化形状时**改掉**，不是默默放宽）。

两个自己抓住的错，记下来是因为它们都是"看起来对"的错：
1. `chest_free` 第一版只比容量不比实铺 —— 一个只铺 1 条进料带的形状会被判成"无箱可铺"，因为容量够。
2. `blocked_by` 第一版用 `(outlet.arms or 0) > 0` 当"还在用箱子"，结果把 **row-belts 带子末端的收料箱**
   和**两台机器中间那只出料箱**混成一句话 —— 玩家指的是第二种，而第二种在 row-belts 里根本不存在。

一处**故意没做**：挑选逻辑（ladder/redraw）还没读 `lane_plan`。让默认开始追"成品带够不够"会把
`iron-plate` 熔炼线从 row-chest 推到 row-belts，那是要连着改一批钉死的旧数字的行为翻转 —— 它应该和
#7（新形状真的铺得出 F+P 条带）、#8（默认去箱）一起做，一次改、一次把受影响断言逐条重写并写明理由，
而不是分三次把同一批数字改来改去。

多产物那个洞的真实尺寸：铀处理出 U-235 (0.105/分) 与 U-238 (14.895/分)，旧算法按第一个产物看这条线，
等于认为它几乎不需要带子 —— 差 140 倍。

## 7. 2026-10-06 深夜：`stacked` 形状在了，生产那一证还差一把夹具

`styles.lua` 新增第五个形状 `stacked`：**F 条进料带叠在一面 + P 条成品带独占另一面，臂按档数分派，机器之间没有通道、一只箱子都没有**。带子数量是 `card_example` 在铺之前用 `lane_demand()` 从流量算出来的（§4.5 那套式子），每档臂单独点名；缺哪一档臂、或者要的带行数超过一个面叠得起的上限，**在铺之前就按名拒**（`ARM_TIER_MISSING` / `LINES_BEYOND_SHAPE`），不铺一条喂不到的线。

`card_place` 真建到 `arch-sandbox`：55 件全落下、无 refused；`card_verify` 早先一轮报 12 只臂无一瞎臂，取放关系就是量到的那条律（reach 1 喂近带、reach 2 喂远带、成品臂从机器取、放到自己那一面的带上）。红板×4 的读数：**13x8、39 带、12 臂、4 机器、0 箱**（`two-feed` 是 21x11 + 8 只箱）。

### 生产那一证：没证，而且原因本身就是结论

`dev/stacked_line_probe.js` 跑到"三种料都进了机器"就停了：机器进料仓里有齿轮和电路板，**永远没有铜线**，`progress` 恒 0。原因不是臂不工作，是启动顺序死锁 —— 同一条带上的两种料里，进臂先抽离它近的那一股；那一股先灌满**每类型 20 件**的进料仓上限，臂再也放不进去，就按 §4 相 D 那条律**永远卡在手里的件上**，另一股一辈子轮不到。

所以这条线有个硬要求，不是审美：**一条带要两股各装一种料，这两股就必须被分别喂**。而玩家不许箱子 ⇒ 线头只能是裸带尾 + 一块写清"第几条带子的第几股装哪种料"的牌，由他自己的总线在卡外按股接上。这把"按股喂"的夹具是 #9 的一部分，生产那一证等它。

顺带这条律也回头解释了 `two-feed` 为什么能用箱子活下来：它每个面各一条带、每种料各有其股，靠线头箱当"分股的缓冲"。把箱子拿掉，分股这件事就必须在**线头外面**由玩家（或我们下一版的牌）做。

### 这轮新冒出来的两个真洞，各立一条任务

1. **挑机器的时候没人问"它能做这个配方吗"**：本台架一开始用 `advanced-circuit`，那个配方**这个存档没研究**（`force.recipes[...].enabled = false`），而 2.0 的 `set_recipe` 照单接受、`get_recipe` 也读得回来，于是机器有电、料吃满、progress 永远 0。默认挑到的 `assembling-machine-1` 也有同类问题。答案里现在只有 `recipes.bound/no_setter`，看不出"配方做了也没用"。
2. **`card_place` 从冻卡建时绑了 0 个配方**：`card_freeze` 收的卡里没带 `machine_recipes`，落地的 4 台机器全是空的（`wires.recipes.bound=0`），玩家得自己一台台点 —— 正是这条工具链存在的理由之一。要么冻卡时把配方一起冻进去，要么 `card_place` 按 `card.recipe` 兜底绑。

### 还没做、按顺序等在前面

`shape_ladder` / 重画仍然只按料数与 `unfed` 走，**没读 `lane_plan`**：这是故意的（§6 末段），因为让默认开始追"成品带够不够"会把 `iron-plate` 熔炼线从 `row-chest` 推到带子形状，那是一批钉死旧数字的行为翻转，该和 #8（默认去箱）一次做完、一次把断言逐条重写。`stacked` 现在只有点名 `style:"stacked"` 才用得到。

## 8. 2026-10-06：那一根红的不是模，是门禁自己在猜世界状态

0.60.27 第二遍全套 = `235 passed, 1 failed`，红的是 `layout_ledger` 里那条多产物复算，FAIL 带的数是 `["NO_AVAILABLE_PART",[],null,0]`；同一个文件单跑几分钟前还是 `236 passed, 0 failed`。

根因不在形状：**门禁的顺序把它自己钉的世界状态喂给了后面的套件**。`dev/smoke.js` 不是"研究它那 7 项"，是把科技**设成**那 7 项（其余 `researched=false`、配方 `enabled=false`），因为不这样的话，谁在同一个 session 里手工探过一次 `electric-furnace`，下一次 `solve` 就换个机器答同样的请求。`uranium-processing` 那项科技同时解锁 `centrifuge` 和铀处理配方，于是它被撤掉以后，离心那条卡按名拒 —— 拒是对的，卡说的是真话；红的是那条**要数字**的断言拿到了空 contract。上一轮我为这个加了个"要么量到数、要么按名拒"的护栏，护栏绿了、下一条照样红：护栏只负责把原因写清楚，不负责让复算有数可复。

改成跟这个文件里 `advanced-circuit` 一样的做法：**只为这一跑借科技，跑完照原样还**（`grantUr(true)` → `card_example` → `finally grantUr(urWasOn)`，还的是进来时读到的那份状态，不是硬写 false）。断言本身一个字没放宽。复现方法记在代码注释里：`bash dev/test.sh node dev/layout_ledger.js` 之前先手工撤掉 `uranium-processing`，改前 235/1、改后 236/0。

顺带查出来的一件更值得记的：`dev/locale_check.js` 认 `fail_key("CODE", "m-key", ...)` 这个**形状**，而我新写的 `STYLE_CANNOT_LAY` 那句 code 是运行时选的（`fail_key((style_why and style_why.why) or "STYLE_CANNOT_LAY", "m-style-no-lay", ...)`），形状对不上，于是那个 key 带着"两种语言都没有这一行"上了盘，面板真走到那一步会直接打印 `architect.m-style-no-lay`。修法不是给这一处开后门，是把扫描从"调用形状"换成"**命名约定**"：任何 `"m-..."` 字面量都算用过的 key（`dev/locale_check.js` 第六种读法）。这条加宽之后立刻只报出这一个缺失，没有一个误报 —— 说明这个约定全仓库守得很干净，值得当规则用。



## 9. 2026-10-06（0.60.28）：`heads` 通到压线和面板，裸带线头的阶梯从 `stacked` 起步

上一版 `stacked` 只有手工点名才用得到。这一版把它接到玩家实际走的那两条路上：

1. **面板**多一格「线头」（`arch-form-heads`：自动 / 箱头 / 裸带），`read_form` 读回 `heads`，`helmod` 与 `helmod_all` 两个按钮都把它传进 `M.helmod_ghosts` / `M.helmod_blueprints`。
2. **压线**把 `heads` 传进 `card_example`（`build_with` 与 `build_as` 两处），并把 `shape_ladder(m, materials, heads=="belt")` 的第三个参数交出去：裸带线头时阶梯 = `stacked → two-feed → row-belts`，旧名单原样留在后面。
3. **裸带线头的默认**：`card_example` 里 `heads=="belt"` 且没点名形状时，起点从阶梯取 `stacked`。这一步只影响"要了裸带"的调用；不表态仍然是 `row-chest` + 箱头，所以上面第 2 条那批钉死旧数字的断言一个字没动就还是绿的。
4. **形状是偏好，不是许可**（§2.4）：`stacked` 铺不出来（`ARM_TIER_MISSING` / `LINES_BEYOND_SHAPE` / `BELT_CAPACITY_UNKNOWN` / `STYLE_CANNOT_LAY`）时，阶梯落回下一个**接得住裸带**的形状，但只接受"料齐"的那一张（`#unfed == 0`），否则照原样按名拒。落回时答案带 `style_overridden = {asked, used, code, because}`，`because` 里就是那个没过关的数（要几条带 vs 一个面叠得起几条）；面板把它渲染成单独一行（`n-hm-shape-moved`），日志把它写在「线卡」那一步的「搬形状」字段里。
5. 线的记录改读**铺出来的**形状：`lanes[].shape = c.style`，另外带上 `asked_shape`（阶梯要的那档）、`head`、`chests`、`style_overridden`。从前 `shape` 记的是"问的那个名字"，卡内部换过形之后这一行和地上的带子就对不上了。

### 这一轮自己踩的三个坑（都是"从记忆写数字"那一类）

- 想让落回真的发生，我先用 `iron-plate × 4 台 + transport-belt`，结果阶梯没动：我按"黄带 15/分"算的，实际是 **15/秒 = 900/分、每股 450/分**。要顶到 3 条带（> 一面上限 2）得 64 台。式子读回来了却不代进去，等于没读。
- 断言"蓝图里有那块牌"用正则找 `display-panel` —— 蓝图串是 gzip+base64（`0eNq...`），永远找不到。改成数 `lanes[].parts` 的键（`display-panel` / `decider-combinator` 都在里面）。
- 压线那条新断言第一次红在 `HEAD_SIGN_UNAVAILABLE`：显示面板锁在 `circuit-network` 后面，而套件之间谁也不保证那份科技在不在。**和 §8 同一个教训**：借来、`finally` 照原样还（`grantNet`，读进来时的那份状态）。

### 门禁自己抓到的两根

- `refusals` 的镜像规则报出 `LINES_BEYOND_SHAPE` 已不该再挂在"这台安装到不了"的名单上 —— `belt_head_e2e` 现在把它量到了（顺带把落回那条路也量到了）。同一处注释还谎称 `stacked_line_probe` 会命名这两个码：那个文件一个码都不命名，注释已改成实话。
- `layout_ledger` 两根红是这次默认翻转本身：它们用"裸带 + 不点名"取卡来钉 `two-feed` 的几何。改成点名 `two-feed`（那条断言的主体是 two-feed 的两面一排臂），另加一条钉新默认（红板×4 裸带 → `stacked`、牌上四道、0 箱）。`234/2 → 237/0`。

## 10. 2026-10-07（0.61.0）：删到只剩一条链 —— 玩家说"其他功能全部删掉"

玩家的话：只保留"通过 helmod 生成蓝图"，其他不相关的**一定要删**，目的是少代码、少每次分析代码的时间、少测试时间；但以后要能做采矿蓝图与各类电路蓝图。

审计先跑（可达性闭包），再动手，避免"看着不相干其实被压线调着"。基数与结果：

| | 删之前 | 删之后 |
|---|---|---|
| `src/architect/*.lua` | 26,858 行 / 18 个文件 | ~14,100 行 / 13 个文件 |
| `dev/*.js` | 89 个 | 31 个 |
| 面板 `gui.lua` | 2,689 行 | ~1,050 行 |
| 语言文件 | 694 / 686 行（634 键） | ~287 / 279 行（206 键） |
| RCON 方法 | 56 | 17 |
| 全套门禁 | ~40 分钟 / 29 个套件 | 一次跑完看 `.factorio-test/regress_s1.txt` |

**删掉的岛**（连同各自的 dev 套件）：电力与电线杆规划（`power.lua`、`verify` 的 plan/verify 那半壁）、钻头/泵/农场三台 rig 与 `line_watch`（`measure.lua` 的 820+480+475+295 行）、求解器（`solve.lua` 整包 1,621 行）、区域与 `能否放下`、卡片存放/冻结/放置/布线（`card.lua`+`compose.lua` 那套门）、总线与走廊（`bus_example`/`corridor_example`）、提问队列、面板上除压线以外的所有区（拖框、计划表格、卡片页、台架行、总线页）。整文件消失六个：solve / compose / region / power / seams / fields。

**故意留下的三样，和它们的理由**（这三样都不是"顺手留着"，删掉会直接伤到玩家自己定的规矩）：

1. **台架 `card_lab` / `lab_*`**：它是这个模里唯一能回答"这条线真的在产出"的东西。玩家需求第 2 条（可选排法的前提是能正常生产）只有它能自证；`helmod_ghosts` 自己明确"不测"（答案里那句 no card, no lint, no measurement）。
2. **臂的实测量 `arm_rate`**：删了不崩，但会**悄悄降级** —— `arm_ceiling` 变 `measured=false`，单台机器那条 lane 不再会说"你这条带的量超过这只臂"；同档臂的排序也退化成只看造价。这类"照样给答案、只是不再说实话"比留 440 行更贵。
3. **`card_check` / `card_verify` 这两道 lint**：它们不在压线的调用链上，但" belt 指进固体 / 臂够不着机器 / 口指向不存在的实体"这几条几何规矩只有它们能当场拒；`layout_ledger` 那 12 条"引擎接受这个形状"靠的就是它。

**"以后能做采矿/电路蓝图"的余地落在哪**：`styles.lua` 的形状注册表 + `roles.lua` 的零件挑选阶梯 + `blueprint_specs`/`blueprint_item`/`hand_blueprint`/`set_ghost_recipe` 这四件作者化 + `place_undo` 的撤回账本。这几样全留；`card.lua` 里那半截电路布线不作为种子保留（留着就要连带 compose 与 380 行布线簇），真要加时按 API 重写更干净。

### 删除时踩到的三根，都是"门禁自己会骗人"那一类

- `dev/locale_check.js` 把"键在文件里但没人用了"也算红 —— 所以**删 Lua 必须同一批删两份 .cfg**，否则下次谁改语言文件都先被一堆死键淹掉。写了 `/tmp` 里的一次性修剪脚本，按"字符串字面量里还出现就不删"兜底，避免误伤 `L(hm.msg_key or "report-idle")` 这种动态读法。
- `dev/refusals.js` 的镜像检查（"名单上的码源码必须还在发"）在删完代码后立刻变红：58 个码挂在 DEFENSIVE/TODO 上而源头已经没了。**这是这条门禁值钱的地方**，不是它烦人。
- `dev/regress.sh` 有两处会记住历史：硬编码的套件表，和 `SKIP_E2E` 的"名单上的文件必须存在"。删文件不同步改这里，下一次全跑会红在一件没发生过的错上。`dev/quick.sh` 的面积表和 `dev/cycle.sh` 里"暖油田"那一调用同理（油田夹具随钻头 rig 一起没了）。

### 一句可逆路径

整个 S1 是一个 commit。要看删掉了什么：`git show --stat HEAD`；要退回去：`git revert HEAD`（工作树会连 locale、套件表一起回去，不需要手工补）。

## 11. 2026-10-07（0.61.0 续）：那一轮红有一半是我自己制造的，另外三个是真缺陷

S1 的第一次全量门禁报了 5 套红。事后逐条量，**其中 refusals / layout_ledger / arm_pair / belt_head 四条红的是同一件事**：我在门禁跑着的时候自己往 RCON 上发了探针（量 mod_gui、量运力、量形状），于是那一轮的"世界状态"里混进了我的调用 —— 一个 lab job 被我起在中间、一份科技被我改掉、一块台架被我留在地上。玩家自己立的规矩（"跑全量门禁时不要动仓库、不要并发两套"）我破了一次，方向还反过来：不是我在改文件，是我在**用**文件。

教训落成一条可执行的：**跑门禁期间不碰 RCON**。要量东西就等门禁，或者在另一台（27015）上量。

清掉这层污染之后，剩下三个是真缺陷，都不是"套件写错了"：

1. **`refusals` 那两条 lab 断言钉的是时序，不是规矩。** "第二个 `card_lab` 该 LAB_BUSY" 用的是 `seconds:60, speed:20` —— 在这台无头服上那就是**真实 3 秒**，两次 RCON 调用之间 job 自己跑完了，于是 LAB_BUSY 永远不响，而第二个 job 把第一个的台架**孤儿化**在 arch-lab 上（30 件零件站着，下一套踩到）。改法：先 `lab_reset` 把记录清成"确实没有"，窗口要长到不可能在两次调用之间结束（`seconds:600`），并且**由断言自己 `lab_stop`**，不靠时间到。
2. **`arm_pair_probe` 量的是它自己的地面。** 它站在 arch-lab 的 (7300,7300) 那一角，而那一角生成出来是 `out-of-map`；`create_entity` 不看地形照样建，`can_place_entity` 看地形于是答 false —— 于是"引擎不肯让两只臂站在同一行"这句结论其实是"这里没有地"。从前它是绿的，因为被删掉的农场 rig 会路过把那片地刷出来（和 §10 里电臂量成 0 是同一根线）。改法：探针**自己刷自己那一块**，并把 `tile_under_arm=` 和 `painted=` 打进答案里 —— 让下一次读的人看得见它站在什么上面。
   同一台架里还有两处自己的错：`set_recipe` 用的是 1.1 的表形式（`set_recipe{index=1,recipe=...}`），2.0 要的是 `set_recipe(name)`，答"Invalid RecipeID"；成品臂站在机器 3 格宽**之外**的那一列，取货面落在空地上。修完之后结论是玩家要的那个数：**同一行相邻两列、都贴着同一台机器，两只臂站得住，也确实同时在搬东西**。
3. **`layout_ledger` 一遇到拒答就崩，把后面所有断言一起带走。** 修崩的同时暴露出我自己写进去的一个错（把"转 90° 换轴"的第二行写成了 `v.height === v.width`）—— 五根红的都是这根。同一批把 `partKind` 从**按名字猜**改成**问原型 `type`**：`electromagnetic-plant` 是装配机器而名字里没有 "assembling"，从前它算 "-"，站在它旁边的臂就成了"没人喂的臂"。

顺带清的两处"门禁自己会骗人"：`control.lua` 里 `rig_teardown` 有两份（后一份遮蔽前一份，前一份是死代码 —— 修剪脚本留下的），`dev/refusals.js` 那份手打的"扫哪些套件算证词"名单换成扫目录（名单随删除变成谎话清单：文件不在了还替它作证）。扫目录之后立刻暴露一个新细节：`layout_ledger` 里 `if started.code == "PLAYER_ONLINE" then 重试` 是**处理**一个码，不是**断言**一个码，于是加了一条"以 if/while/return 开头的行不作证"。

## 12. 2026-10-07（0.61.0）：三个把手开同一扇窗，外加自动刷新

玩家要的三件事：起个正式名字、右下角工具栏加图标、右上角像 helmod 那样有个窗口按钮，并且保留手动刷新再加自动刷新。

- **名字**：技术 id 仍是 `architect`（存档、`mods/` 里的包名、`remote.add_interface("arch")` 都挂它，改它等于换 mod）。显示名走 locale：`info.json` 的 title 是单份字符串，写"铺线师 Linewright"；窗口标题读 `L("app-title")`，英文窗口是 Linewright，中文窗口是铺线师。
- **右下角快捷键**：`data.lua` 里一个 `ShortcutPrototype`，`action = "lua"` → 引擎只发 `on_lua_shortcut`，开还是关由 `gui.on_click` 的 `arch-toolbar` 那一格决定 —— 于是 `/arch`、工具栏、右上角按钮**三条路进的是同一个 `G.toggle`**。图标必须是自己 mod 里的文件：这个 build 不允许 mod 引用 `__base__/graphics/...`，所以 `dev/make_icon.py` 按尺寸算出 32 与 24 那两张（同一张画，两处入口认得出是同一个东西）。
- **右上角按钮**：`require("mod-gui")` 的 `get_button_flow(player)`。**这里量到一条硬事实**：运行期不能 require —— 引擎直接回答 `Require can't be used outside of control.lua parsing.`，所以那份库只能在 `gui.lua` 被解析的那一刻取好、缓存成 upvalue。建按钮的时机是 `on_player_joined_game`，中途加装由 bootstrap 补一遍；**`game` 在 `on_load` 那一刻还不存在**（第一次试的时候整张图加载失败：`attempt to index global 'game' (a nil value)`），所以那一步包在 `if game then` 里。
- **自动刷新**：头部一格 checkbox，状态记在 `storage.gui_panel[idx].auto_refresh`；`on_nth_tick(60)` 只给"窗口开着并且这一格亮着"的玩家重读 helmod 那份工厂表，**只重画 helmod 那一行**（`G.refresh_world`），答案区、蓝图串、两个下拉都不动 —— 玩家刚读到的那段话被一次刷新擦掉是这一格最不该有的行为。手动那颗"刷新"原样保留。下拉的选中项按**工厂页 id** 复原，不按序号（helmod 少一页时序号会指到别的东西上）。
- 这三样都在 `gui_selftest` 里有无头断言（按钮建出来没有、画的是不是注册的那张图、快捷键那一按窗有没有关、刷新前后答案的行数相不相等），`smoke` 各钉一条，红的时候说得出是哪一件。

## 13. 2026-10-07（0.62.0）：带子改成"够用就好"，牌从头一块变成头尾各一块

玩家那句"通过 helmod 生成蓝图时传送带也要够用就好或者可以选，我看现在应该是选择速度最快的"——量过，确实
是按 `belt_speed desc` 拿最快那一档。改法是把"挑档"这件事交给流量：

- `card_example` 里 `lane_demand(machines, belt_name)` 多收一个档名（同一台架要拿每一档各算一遍），
  然后从这一发放得下的**最慢**那一档往上试，取第一条进料与成品都装得下的当带子；点名了一档（`belt`）就
  照点名的来，不升级也不降级。
- 答案里多了 `belt_choice = { asked, chosen, tried[], adequate, per_lane_min, feed_rows, product_rows,
  rows_per_face }`：试过了哪几档、为什么停在这一档、这一档一面叠几行。`components_how.belt` 同一句话。
- 窗口里"带子"那一格是"可以选"那一半：第一行不表态（够用就好），往下是零件阶梯交出的档，名字用游戏自己
  的翻译后面跟原型 id。

代价说清楚：同一张 4 台组装机计划，黄带子装不下那么多股，于是落成 **2 条线**而不是 1 条。这正是那笔交换
——省的是润滑剂，不是线数。`smoke` 里那条"压一页铺出的是带臂机器"从前钉 `lanes === 1`，现在钉的是
**计划里的机器一台都不能少**（各线 `machines` 之和 == 4）+ 喂得齐 + 件数对得上；`helmod_ghosts_e2e` 里
那条钉死 `fast-transport-belt` 的改成"任何一档带子都算"，因为档名归 `belt_choice` 说，不归另一扇门抄。

牌：`head_sign` 加了一个 `side` 参数，线头站北往北长（写这条线吃什么），线尾站成品行之南往南长（写它吐
什么），两块牌同一个函数 —— 两份几何迟早会长成两个样子，那时候发现的人是玩家。股道编号是同一套全局号
（1 = 离机器远的那一股，2 = 近的，第二条带子续 3、4），所以从任何一头读都对得上同一根带子。每线的零件
从 2 件变 4 件（两只发射器 + 两块面板），`others` 那格数得出来。

## 14. 双排的前提量下来了，还有两处门禁会自己骗人

`dev/lane_side_probe.js`（新，5/5，已进名单）量的就是"两排机器共用中间那条成品带"成立与否的那一格：
一条向东的带子，北边一只臂放 iron-plate、南边一只臂放 copper-plate，下游三个格子分别读两股 ——
**北臂的料在 line2、南臂的料在 line1，两臂各占一股**。所以双排不需要分流器就能让两排成品走同一条带子。
这台架同时纠正了一处过度声称：它只量"哪个索引装哪只臂的料"，不声称 line1 是南半边还是北半边（那是
`belt_stack_probe` 量的"臂只装远股"那条规矩管的事）。

两处新闸都是今天被自己咬出来的：

- `dev/lua_templates.py`（进 `cycle.sh` 与 `regress.sh`）：dev 脚本里每一段发给 `/c` 的 Lua 都要能解析。
  编译失败的 `/c` 回答**空字符串**，所以一个坏查询长得和"世界上没有这个东西"一模一样 —— 今天
  `arm_pair_probe` 少了一个右括号，读数空了三轮，而它检查的那件事一度同时"通过"和"失败"。
- `dev/locale_check.js` 现在抓重复键。`* text eol=lf` 那条 .gitattributes 也补了 `*.png binary`：
  PNG 的文件头**必须**有 CRLF，前一次提交把它规范化成 187 字节、签名坏了 —— 是 `git show :path` 比字节
  才发现的，图标因此没跟着坏掉。
