# helmod 数据口径改造（#35）—— 已收口（0.73.0 ①② / 0.74.0 B1 / 0.75.0 B2 / 0.76.0 ③ / 0.77.0 ④ / 0.78.0 ⑤）

> 这份文档现在是**资料**，不是待办：里面"式子抄录"与"接口能给什么/够不到什么"那两节是实测与读源码换来的，
> 别再重新探索一遍。想知道接下来做什么，看 `dev/待办.md`（0.78.0 之后 #35 已闭，剩下的是功能不是 bug）。

## 0. 玩家要的是什么（原话口径）

- **全部用 helmod 的数据**：机器数、每种料的流量、需要几条带子，都不得由我们自己再算一遍。
- **带子条数按"半条"这一格取整**：一条带子 = 两条股道，所以最小格是 0.5。
  - 0.4 → 0.5（半条 = 一股）、0.6 → 1（整条 = 两股）、0.8 → 1、**1.1 → 1.5**、1.6 → 2。
  - 方向 = **向上贴到最近的半条，不欠料**（2026-10-08 玩家明确："1.1 先按 1.5，主要先把整个数和 helmod 算对"）。
- 还要知道 helmod 那个数是**按哪一档带子**算出来的（普通 / 高速 / 极速 / 涡轮）。

## 1. 已经做完的（①②）

`architect 0.72.0`（提交 `d8b189a`）：带子容量折进 `belt_stack_size_bonus`。

- `lane_of(item, tier, spine_tiles, force)` → `per_min = throughput_per_sec × 60 × (1 + force.belt_stack_size_bonus)`。
- 两个调用处都传了 `force`：`lane_demand`（算进料/成品要几股几行）、`belt_ceiling` 那一块（`lane_carry`）。
- `belt_choice` 与 `belt_ceiling` 各带一个 `belt_stack_size_bonus` 字段（同一发在不同加成的存档上会给不同行数，读数的人要看得见前提）。
- 实测凭据：40 台电炉 + 点名黄带 + 单排 —— 加成 0 级 → `LINES_BEYOND_SHAPE`（"要 2 条进料带和 4 条成品带，一个面最多叠 2 条"）；加成 1 级 → 铺得出来，`belt_ceiling.per_min` = 1500/分。

`architect 0.73.0`：压线链的分子改成 helmod 折好的那一份（②）。

- **一个出口**：`card_example` 里"这条线每分钟过几件"现在只有 `rate_for(machines)` 一处会算。带 `args.flows`
  （压线链给的）就从 helmod 那一份读并按台数等比缩；不带就是"不经过 helmod、直接要一张卡"那扇门，仍走
  `speed × 60 / energy × 台数`。`lane_demand`、`belt_ceiling.claimed_per_min`、`feed_plan` 三处都改成读它，
  所以同一个计划不可能再有两条分子。
- `helmod_line_flow(那一行, 记账台数)`：把树上那一行原样交给 `get_recipe`，读**返回值**里的 `count`，
  乘 `60/base_time` 换成 /分；名单（吃什么/吐什么/喝什么）也一起从这份里读，不再用原型清单配 helmod 流量。
- **台数是记账用的，不是重算**：`flows.machines` = 这一发要铺的台数（整线缩放 1），拆成几条线时每条拿
  `m/记账台数` 那一份；helmod 自己那 `factory.count` 可能是小数（1.6 台），原样交在 `helmod_machines` 里。
- 答案里看得见的：`rate_source = {source="helmod"|"self", crafts_per_min, scale, quoted_for, helmod_machines,
  base_time, crafts, machine, craft_energy, belt}`，`feed_plan.fuel`（燃料单独说），步进日志第 04 步"分子"
  （来源、每分工艺术数、页档位、产物、有没有折上 productivity）。
- 实测凭据（同一行、10 台钢炉、productivity 0.08）：`产物=iron-plate 405/分`、`这张卡许诺每分=405`，
  而没带 flows 的那一张是 375/分 —— 差的就是我们自己算不出来的那一成；40 台拆成两条线时每条 `scale=0.5`、
  每条 750/分，两条加起来仍是 1500。
- 门禁：`dev/helmod_ghosts_e2e.js` 加了 5 条（来源、燃料不进料单、405 vs 375、问不到时按实说 self、
  拆线各拿一份）。

## 2. helmod 的接口能给什么（全部实测/读源码得来，别再重新探索）

- `remote.interfaces["helmod_interface"]` **只有两个函数**：`get_models()`、`get_recipe(recipe)`。
- `get_models()` 交出的就是 `storage.models` 那一棵树（**每次调用一份深拷贝**，不是引用：`remote.call` 两个方向都拷贝，见下面 `get_recipe` 那条实测）。每页 `model_N`：
  - `Model`：`id` `owner` `class` `block_root` `parameters.effects{speed,productivity,consumption,pollution,quality}`
  - `Block`：`name` `index` `ingredients` `products` `children` `count/count_limit/count_deep` `energy/power/power_limit` `pollution` `by_product` `unlinked` `summary` `summary_global`
  - summary：`{building, building_limit, building_deep, factories={}, beacons={}, modules={}}`；每项 `{name, quality, type, count, count_limit, count_deep}`
  - `Recipe`（`class="Recipe"`）：`id` `name` `type` `count` `factory{name,quality,fuel,energy,speed,modules}` `beacons{name,amount,combo,per_factory,per_factory_constant,modules}`
- **两个坑已踩过并写在代码注释里**：① 数字在 `block_root` 下面，不在 Model 那一层；② `summary_global` 已经把子块算进去了，再往下读会把 6 台报成 12 台。
- `get_recipe(t)` 回填 `products`/`ingredients`。**2026-10-08 实测纠正**：`remote.call` 把表参数**拷贝**过去，
  改写落在那份拷贝上，**读返回值**（`local r = remote.call(...); r.products`），传出去的那张 `t` 原样不动。
  每一项带 `name` `type` `quality` `amount`（**原型**的单件量，不含 productivity）与 `count` = 折过的单件量
  × `t.count`（折过 productivity、模块、信标、quality），另有 `count_limit`/`count_deep`（我们没传就等于 0）。
- **折 productivity 的硬前提**：`t` 里要带 `time`（单次工艺的能量秒数，树上写在 `row.time`）与
  `factory.effects` / `factory.speed` / `factory.speed_total`。实测 `Product:getProductivityBonus` 第一句
  `if recipe.time == nil then return 0` —— 少了 `time`，加成会在交回来的数里悄悄归零（30 次/秒的板子：
  带 `time` 回 32.4，不带回 30）。所以 `recipe_row` 现在把 `crafts`(`row.count`)、`time`、`base_time`、
  整张 `factory`、`quality`、`type` 原样抄下来。
- **单位是"每 `base_time` 秒"**：`base_time` = 那一页显示用的档位（`block.time` ← `model.time`，实测默认 1 =
  每秒；helmod 的档位表 1s/1min/5min/10min/30min/1h/6h/12h/24h，`core/defines.lua:262`）。换算到 /分 乘
  `60/base_time` —— 这份换算只写在 `helmod_line_flow` 一处。
  实测对得上：48 台钢炉做铁板 = `row.count` 30 次/秒、`factory.amount` 1.6、`factory.count` 48、products 32.4/秒。
- **燃料那一行带 `burnt=true`**（实测钢炉的 iron-plate 多出一行 coal 0.036/次；燃烧室的流体燃料同样标 `burnt`）。
  这一模的带子不搬燃料，所以它不进料单、不占股数，单独交在 `feed_plan.fuel` 里（不吞掉）。
  还有 `type=="energy"` 那一行（steam-heat，核电的机器自吃），也不上带子，数着但不进账。
- **够不到的**：`storage.preferences`（"默认用哪条带子"、以及用户在 helmod 面板里覆盖的 `belt_stack_size_bonus`）、`storage.rules`、`storage.default`。也试过全局：`User` / `Product` / `Model` 在 helmod 环境外都是 `nil`（实测）。
  → 所以"用哪一档带子"只能来自**我们窗口那一格**（`arch-form-belt`，已存在，会记住上次选择），答案里要这么写，不许写成"同步了 helmod 偏好"。

## 3. helmod 算带子的式子（`model/Product.lua` 原文抄录）

```lua
belt_ratio = 45 / 0.09375            -- = 480 件 / (每tick格数)
条数 = count / (belt_speed * (1 + User.getBeltStackSizeBonus()) * belt_ratio * time)
-- User.getBeltStackSizeBonus() 默认 = player.force.belt_stack_size_bonus
```

- 我们的 `speed × 8 × 60`（每秒件数）= `speed × 480` —— **同一个常数**，不用动（`belt_rate` 台架也对过：普通带量到 939/分、模型 900/分；见 `dev/belt_rate_e2e.js`）。
- "一股 = 半条带子"这条律是**量出来的**（`belt_rate`：每一档"一股 ÷ 两股" ≈ 0.5），所以 `lane_demand` 里那个 `/2` 是对的，保留。
- `time` 是 helmod 的显示基准（它界面里"每秒/每分钟"那一档 = `block.time`）；我们用 /分，换算已经统一写在
  `helmod_line_flow` 一处（`count × 60 / base_time`），别处不再乘第二遍。

## 4. ③④⑤ 都落地了（当时按序一步一提交；原文留着当规格）

### ③ 带子条数：helmod 式子 + 半条取整 + 两个口径并列
- 新增一个函数（放在 `lane_of` 旁边，别处只调用它一份）：
  `belt_need(count_per_min, belt, force)` → `{ need = 原始分数, belts = math.ceil(need*2)/2, lanes = belts*2, bonus, belt }`
  （`need = count / (belt_speed × (1+bonus) × 480)`，单位统一成 /分就 `count / per_min`）。
- 行数仍由几何律决定：**股数 ÷ 每行能装几股**（`style.product_lanes_per_line`：单排 1、双排 2；进料行一股不落，2 股一行）。
- 答案里两处并列：`belt_need_helmod = {raw=0.6, rounded=1, lanes=2, belt="fast-transport-belt", bonus=1}`，以及现有 `lane_plan`（铺几行）。窗口加一行话：`helmod 0.6 条 → 取整 1 条(2 股)；这一页铺 N 行（单排只有一面朝它放货）`。
- 新 locale 键要 en + zh-CN 两份，且 `dev/locale_check.js` 认那条"无参数那一形必须逐字相等"的规矩：要带参数就用 `__1__`，别在 Lua 里拼尾巴后指望它不报错。

### ④ 措辞诚实
- 所有"同步 helmod"的地方改成"取自 helmod 的这棵树 + 我们窗口选的这一档带子"；加成从 `force` 读这件事也写明（不是它的偏好覆盖值）。

### ⑤ 门禁
- `dev/layout_ledger.js`：钉 `belt_need` 的取整表（0.4/0.6/0.8/1.1/1.6 → 0.5/1/1/1.5/2）与"行数 = 股数 ÷ 每行几股"。
- `dev/helmod_ghosts_e2e.js`：钉压线答案里 `belt_need_helmod` 存在、`belt` 与 `bonus` 说的是同一档、且 `lanes = rounded × 2`。
- 加成不是常数：断言要**自己读** `force.belt_stack_size_bonus`，或者像 `belt_rate_e2e` / `layout_ledger` 那样临时改 force 再还原（改完必须还原，否则下一个套件看到的存档就不是它以为的那个）。
- 跑法（AGENTS.md 定的）：日常只 `bash dev/test.sh bash dev/cycle.sh`（秒级静态门）；点名跑
  `bash dev/test.sh node dev/layout_ledger.js` 这种单套。**全量不跑**（2026-10-08 他明确"以后尽量不跑全量
  测试"）：只有他说"跑全量/测一下/交出去"才动 `dev/regress.sh`，版本号变了不算理由。
  所有命令都要 `bash dev/test.sh` 前缀（漏了会动到 27015 那台玩家连的服务器）。

## 5. 顺手还没做完的（同一条链上的其它问题）

整条链上其它没闭的（B1 模块不进账、B2 换机器不改口、5 种料以上、通用产线、样式随蓝图旅行…）与**已经闭的
清单**都在 `dev/待办.md`，那份是对着 0.73.0 的代码逐条核过的。这里只留这一刀紧邻的两条：

- **#32 牌位只留显示面板**：面板自己带字（`cb.messages` / 蓝图 `control_behavior.parameters` 都实测可用），
  旁边那只组合器对牌子本身已无用；只有走总线的页才需要发射器 —— 而总线那一圈现在根本没铺（下一条）。
- **#31 总线：控制器那一圈几何没铺**（每机一只选择器 / shortage 每候选一只算术盒）。0.69.0 已让卡自己说
  `laid_controllers = 0`，粘出去的一页每台机器读同一个信号；注意 `dev/早上验收.md` 里那个 `#31` 说的是
  农场台架（那套门禁早已随农场台架一起删），两个 `#31` 不是同一件事。

（原来第 33 条"含液体的线只铺一台"已闭：`fluid-back` 那一档现在把多台喝水线铺在一条排里，
`ARM_COLUMNS_FULL` 是按名拒后落阶梯，不再静默退成一台。测试存档借科技的规矩也变了：`layout_ledger` 里
`electric-furnace` 那两条现在自己借配方、用完照原样还，不再要求先重种存档。）

- 存档真漂了还是要重种：`bash dev/test.sh bash dev/test-reset.sh`，然后 `bash dev/test.sh bash dev/cycle.sh`
  起回 27016。

## 6. 一句话交接（已作废，留档）

② 已经落地（0.73.0：压线链的分子只从 `rate_for` 那一处出，带 flows 时读的是 helmod `get_recipe` 折过的
`count`）。从这里开始做 ③：**把带子条数按 helmod 的式子算、再 `ceil(need×2)/2` 向上贴到半条**，与"这一页
实际铺几行"两个口径并列显示。③ 要的分子已经在答案里了 —— `rate_source.crafts_per_min` 与
`feed_plan.needs[].per_min` / `feed_plan.fuel`，都已是 helmod 那份 /分，不需要再换算第二遍；`lane_of`
旁边加那一个 `belt_need`，`lane_demand` 里"每种料 ceil 到整股"那一刀留给它。取整方向 = 向上贴半条
（1.1 → 1.5），玩家已定。
