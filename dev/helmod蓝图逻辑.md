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

