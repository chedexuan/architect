# helmod 数据口径改造（#35）—— 下一会话从这里接着做

## 0. 玩家要的是什么（原话口径）

- **全部用 helmod 的数据**：机器数、每种料的流量、需要几条带子，都不得由我们自己再算一遍。
- **带子条数按"半条"这一格取整**：一条带子 = 两条股道，所以最小格是 0.5。
  - 0.4 → 0.5（半条 = 一股）、0.6 → 1（整条 = 两股）、0.8 → 1、**1.1 → 1.5**、1.6 → 2。
  - 方向 = **向上贴到最近的半条，不欠料**（2026-10-08 玩家明确："1.1 先按 1.5，主要先把整个数和 helmod 算对"）。
- 还要知道 helmod 那个数是**按哪一档带子**算出来的（普通 / 高速 / 极速 / 涡轮）。

## 1. 已经做完的（①）

`architect 0.72.0`（提交 `d8b189a`）：带子容量折进 `belt_stack_size_bonus`。

- `lane_of(item, tier, spine_tiles, force)` → `per_min = throughput_per_sec × 60 × (1 + force.belt_stack_size_bonus)`。
- 两个调用处都传了 `force`：`lane_demand`（算进料/成品要几股几行）、`belt_ceiling` 那一块（`lane_carry`）。
- `belt_choice` 与 `belt_ceiling` 各带一个 `belt_stack_size_bonus` 字段（同一发在不同加成的存档上会给不同行数，读数的人要看得见前提）。
- 实测凭据：40 台电炉 + 点名黄带 + 单排 —— 加成 0 级 → `LINES_BEYOND_SHAPE`（"要 2 条进料带和 4 条成品带，一个面最多叠 2 条"）；加成 1 级 → 铺得出来，`belt_ceiling.per_min` = 1500/分。

## 2. helmod 的接口能给什么（全部实测/读源码得来，别再重新探索）

- `remote.interfaces["helmod_interface"]` **只有两个函数**：`get_models()`、`get_recipe(recipe)`。
- `get_models()` 返回 `storage.models` **按引用**（一棵树）。每页 `model_N`：
  - `Model`：`id` `owner` `class` `block_root` `parameters.effects{speed,productivity,consumption,pollution,quality}`
  - `Block`：`name` `index` `ingredients` `products` `children` `count/count_limit/count_deep` `energy/power/power_limit` `pollution` `by_product` `unlinked` `summary` `summary_global`
  - summary：`{building, building_limit, building_deep, factories={}, beacons={}, modules={}}`；每项 `{name, quality, type, count, count_limit, count_deep}`
  - `Recipe`（`class="Recipe"`）：`id` `name` `type` `count` `factory{name,quality,fuel,energy,speed,modules}` `beacons{name,amount,combo,per_factory,per_factory_constant,modules}`
- **两个坑已踩过并写在代码注释里**：① 数字在 `block_root` 下面，不在 Model 那一层；② `summary_global` 已经把子块算进去了，再往下读会把 6 台报成 12 台。
- `get_recipe(t)`：**就地**改写传进去的 `t`（`{name, factory, quality}`），回填 `products`/`ingredients`，每件带 `count`（按机器与 productivity 折过）、`count_limit`、`count_deep`。不是返回值，别当纯函数用。
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
- `time` 是 helmod 的显示基准（它界面里"每秒/每分钟"那一档）；我们用 /分，传分子时要统一（见 ③）。

## 4. 待做的四步（按序，一步一提交）

### ② 分子改成 helmod 折好的数
- 落点：`src/architect/control.lua` 里压线那一链 —— `M.helmod_factories`（读树）、`take_bag` / `collect` / `walk_recipes`（收集器）、`M.helmod_ghosts` 里 `recipe_needs()` 与每线 `card_example` 之外的"这条线吃什么"的部分。
- 要做：一条线每分钟过几件，取自 `block.products` / `block.ingredients` 的 `count`（它已经含 productivity、模块、信标、quality）；需要单件量时用 `get_recipe{ name=..., factory=..., quality=... }` 回填的 `count`。
- 不要动：`card_example` 自己按 `crafting_speed × 60 / energy` 算 `crafts` 那一路（那是"不经过 helmod、直接要一张卡"的门，保留其自算），但**压线链不许再走它当分子**。
- 记要：`machines_per_line` / `lane_demand` 的机器数用 `summary_global.factories` 的 `count`（含 `count_deep` 时说明是"深算"的那一份）。

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
- 跑法（AGENTS.md 定的）：日常只 `bash dev/test.sh bash dev/cycle.sh`（秒级静态门）；点名跑 `bash dev/test.sh node dev/layout_ledger.js` 这种单套；**别每改一次跑全量**，攒一批再 `dev/regress.sh`。所有命令都要 `bash dev/test.sh` 前缀（漏了会动到 27015 那台玩家连的服务器）。

## 5. 顺手还没做完的（同一条链上的其它问题）

- #32 牌位只留显示面板（面板自己带字：`cb.messages` / 蓝图 `control_behavior.parameters` 都实测可用，旁边那只组合器对牌子本身已无用；只有走总线的页才留发射器）。
- #33 含液体的线在快带子下"没排成一排"：怀疑是 `fluid-back` 的 `F+P` 列位超过机器宽度（`ARM_COLUMNS_FULL`）后退阶梯 → 一条只铺一台；**需要玩家的真实那一页**（配方 + 台数 + 带子档，或 helmod 页名）才能复现。测试存档现在连组装机档都铺不出（`NO_AVAILABLE_PART`），要先借科技。
- #31 总线：控制器那一圈几何没铺（每机一只选择器 / shortage 每候选一只算术盒），0.69.0 已让卡自己说 `laid_controllers = 0`。
- 测试存档如果被手工点过科技而漂了：`bash dev/test.sh bash dev/test-reset.sh` 重种，然后 `bash dev/test.sh bash dev/cycle.sh` 起回 27016。

## 6. 一句话交接

从这里开始做 ②：**压线链的分子换成 helmod 树里/`get_recipe` 折好的 `count`**，然后 ③ 把带子条数按 `ceil(need×2)/2` 取整并与 helmod 的分数并列显示。取整方向 = 向上贴半条（1.1 → 1.5），玩家已定。
