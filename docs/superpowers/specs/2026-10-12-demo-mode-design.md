# 课堂演示模式（demo mode）设计规格

日期：2026-10-12
状态：已分三节与用户对齐并逐节认可，待用户复核本文
适用版本：`main` @ `e44db9c`（本文所引行号以该提交的工作树为准）
关联：`docs/roadmap.md` §3 P0（存档健壮性、真实覆盖事故）、§1.1（"情景过度脚本化"是失败模式）；`docs/superpowers/specs/2026-10-04-save-export-integrity-design.md`（下称"存档规格"）

## 1. 背景与目标

课堂讲规则时，老师要手工点满 16 个季度才能把一条规则的后果展示出来：慢、容易撞门撞错、讲到第 3 年通常已经下课。现有的"暂停运营"（`isPaused`）只能冻住局面供讲解，不能替老师把局面推下去。

目标：一键让系统按剧本自己走完 4 年，老师在**任意操作步骤**上暂停讲解、单步继续、跳到下一季；学生看到的是真实界面在真实规则门控下变动——包括"这一步是谁按了哪个按钮"。

不是目标：不是给学生的自动代做工具，不是 What-if 推演（roadmap §3 P3，有硬性前置），不做多结局与失败分支示范，不进成绩判定链路。

## 2. 本轮已确认取向

| 提问 | 用户选择 | 设计含义 |
|---|---|---|
| 演示给谁用、解决什么场景 | 课堂自动演示一局 | 面向投影，不做学生端 |
| 决策从哪来 | 混合：脚本给意图 + 自动决策填细节 | 需要 `script.ts` 与 `decide.ts` 两层 |
| 与本机真实进度的关系 | 全程内存隔离，退出自动恢复 | 需要 `demoMode` 闸门与三重落盘闸 |
| 推进节奏 | 操作级步进 + 讲解点自动暂停 | runner 以"一次 action 调用"为最小步 |
| 覆盖范围 | 完整 4 年一局 | 剧本含 4 份年度意图，见 §4.4 |
| 讲解词从哪来 | 复用现有规则弹窗文案 | 讲解点只引用 `RULE_SECTIONS`，不新写文案 |
| 面板形态 | 右侧演示抽屉 + 顶部演示横幅 | 八个中心面板零改动 |
| 键盘快捷键 | 要，方便投影操作 | 空格/右方向键，见 §4.7 |

## 3. 现状与差距（代码证据）

| 事实 | 证据 |
|---|---|
| **当前进度 `state` 从不落 localStorage**；全仓唯一键是 `enterpriseSaveFiles`（存档列表） | `src/store/enterpriseStore.ts:386,417,447,504`、`src/components/SaveLoadPanel.tsx:258` |
| 唯一的自动落盘路径：`nextQuarter` 末尾 `setTimeout(() => get().autoSaveGame(), 0)`，每推进一季往存档列表塞一帧 | `src/store/enterpriseStore.ts:2961-2963` |
| 每条变更 action 开头都有 `isPaused` 门，命中即 `return { validationError: '运营已暂停（教学讲解模式）……' }` | `src/store/enterpriseStore.ts:550,611,672,724,775,869,1030,…` |
| **推进季度本身会自动结算绝大部分控制表行**：q-1/2/4/5/7/8/10/11/15/16 与 e-1/2/3/4/6 全在 `nextQuarter` 内完成 | `src/store/enterpriseStore.ts:2135-2965` 的 `stepId` 分布（实测 16 处） |
| 界面上真正需要"按"的动作只有约 10 类：广告、订货会、选单、交货、短贷/长贷、原料单、生产线、厂房、市场/ISO 投资、贴现、支付应付税 | `src/store/enterpriseStore.ts:547-2135` 的 action 清单 |
| 订单池**确定性**：按年定种的 LCG，与运行时刻、广告金额无关 | `src/config/marketDemand.ts:41,58` |
| 跨季透支有守卫：当季现金收支为负则 `nextQuarter` **拒绝推进**并说明缺口 | `src/store/enterpriseStore.ts:2748-2751` |
| 步骤名唯一来源 `CONTROL_STEPS`（30 行），界面与 CSV 已共用 | `src/utils/controlTable.ts:11-42`、`src/components/OperationCenter.tsx:445` |
| 规则文案集中在 `RULE_SECTIONS`，**只有 title、无条目 id**；现有文案测试按 title 查找 | `src/components/RulesModal.tsx:10-110`、`tests/integrityCopy.test.ts:24,44` |
| 同毫秒手操是账实核对的精度盲区，脚本式连点会印出假"账实不符" | README「完整性校验的能力边界」第二条、`src/utils/audit.ts` 的 `INTEGRITY_CAVEATS` |
| 测试环境无 jsdom，`localStorage` 已有内存桩与 spy `setItem` 先例 | `tests/setup.ts`、`tests/saveDigest.test.ts:247` |

差距：仓内不存在任何演示相关代码或文档（全库检索"演示"命中 0）；runner、剧本、决策层、抽屉面板全部为新增。

## 4. 设计

### 4.1 模块边界

新增 5 个文件，每个一个职责，`src/demo/` 除 `runner.ts` 外不 import store：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/demo/types.ts` | `YearIntent` / `DemoStep` / `RunnerPhase` 等共享类型 | 无 |
| `src/demo/script.ts` | 4 份年度意图 + 讲解点表（纯数据，老师改这儿） | `types`、`utils/controlTable` 的 `CONTROL_STEPS` |
| `src/demo/decide.ts` | 纯函数 `(state, intent, year, quarter) => DemoStep[]` | `utils/rules`（BOM、单价、加工费） |
| `src/demo/runner.ts` | 逐季展开队列、播放控制、撞门检测 | store 的真实 action |
| `src/components/DemoPanel.tsx` | 右侧抽屉 + 顶部横幅 + 快捷键绑定 | 只读 runner 状态 |

隔离判据（每个单元能否不看内部就被理解和测试）：`decide.ts` 是纯函数，喂状态出步骤；`runner.ts` 只有时序与状态机；`DemoPanel.tsx` 不含任何业务判断；`script.ts` 是数据。

### 4.2 store 改动（3 处，全在 `src/store/enterpriseStore.ts`）

1. 顶层新增两个字段，与 `state`/`saveFiles`/`validationError` 平级：
   ```ts
   demoMode: boolean;                 // 初始 false
   demoSnapshot: EnterpriseState | null;  // 进入演示前的当前进度
   ```
   **为什么不放进 `EnterpriseState`**：`saveGame`/`autoSaveGame` 序列化的是 `state` 整体，逐帧指纹覆盖 `{id,timestamp,version,resetCount,state}`。放进去会污染存档格式、需要 bump `SAVE_FORMAT_VERSION`，并让演示标记进入核对报告与运行控制表的数据源。放在外层，存档包/指纹/控制表三条链路一个字节都不变。
2. `autoSaveGame` 首行 `if (get().demoMode) return;`——掐掉 §3 那条唯一自动落盘路径。
3. `enterDemo()` / `exitDemo()`：进入时 `demoSnapshot = 深拷贝(state)`（沿用 `createFreshState()`，`enterpriseStore.ts:2993`），`state = createFreshState()` 并强制 `isPaused = false`，`demoMode = true`，清 `validationError`；退出时反向恢复并置 `demoMode = false`、`demoSnapshot = null`。

### 4.3 讲解点与规则文案单源

给 `RULE_SECTIONS` 每项加 `id`（纯增字段，`tests/integrityCopy.test.ts` 按 title 查找，不受影响）：
`ad` / `market` / `orders` / `factory` / `production` / `rd-iso` / `finance` / `save` / `cost` / `time`。

讲解点引用到**条目级**：`{ stepId: 'b-2', rule: { section: 'ad', item: 1 } }`。面板只渲染那一条原文加一个「打开规则说明」按钮，不复述、不另写文案——文案仍只有 `RULE_SECTIONS` 一份。代价是 `item` 是位置索引、重排会指错，因此 §6 第 4 组测试断言每个讲解点存在且不越界；讲解点**指错条目比缺讲解更糟**。

### 4.4 剧本：4 份年度意图

```ts
interface YearIntent {
  year: 1 | 2 | 3 | 4;
  adAmount: number;                 // b-2 前置；决定解锁张数（每 1M 解锁 2 张）
  orderCap: number;                 // 选单张数上限，decide 会按在手产能再裁
  newLines: { factoryId: string; type: LineType; product: 'P1'|'P2' }[];  // q-8
  rdP2: boolean;                    // q-15：本年是否推进 P2
  marketInvest: MarketId[];         // e-5：开拓 + 已准入市场的年度维持
  isoInvest: ISOType[];             // e-5
  shortLoanQuarters: number[];      // q-3：哪几季申请短贷（每次 20M）
  sellFactory?: string;             // q-12
  cashPad: number;                  // 安全垫下限，decide 不许把现金压到它下面
}
```

草案（数值待 §6 第 2 组测试实测锁定后回写，**不作为承诺**）：

| 年 | 广告 | 新线 | 研发/开拓 | 短贷 | 现金垫 | 意图说明 |
|---|---|---|---|---|---|---|
| 1 | 2M | 无 | 启动 P2（Q1–Q4 共 4M）；年末开拓区域 1M | 无 | 6M | 建设年：两条既有全自动线满产 P1，先取得区域准入 |
| 2 | 4M | 大厂房 +1 条全自动 P1 | P2 完成（Q1–Q2）；区域维持 1M | Q1 20M | 8M | 扩产能年，收入曲线抬起来 |
| 3 | 6M | 无 | 区域维持；国内开拓 1M | Q1 20M | **见 §4.5** | 还本年，一切决策给第 3 年末让路 |
| 4 | 4M | 无 | 维持已准入市场；ISO9000 起投 | 无 | 6M | 收官：年末申请长贷 40M 留账，走终局报告 |

意图只说"投多少广告、上不上线、开拓谁"，**不写**"选哪几张单、下几个 R1、哪条线开工"——那些归 decide。

### 4.5 decide 的职责与不变式

每季度按序产出步骤，顺序对齐控制表行位（q-2→q-6→q-7→q-10→q-14→q-15→q-16）：

1. **选单**（`selectOrder`）：从 `availableOrders` 里按"到期季 ≤ 本季 + 在手产能"筛，优先单价高、账期短，张数不超 `orderCap`。
2. **下原料单**（`placeRawMaterialOrder`）：按 `PRODUCT_BOM` 与提前期倒推——P1 需 R1、P2 需 R1+R2，R1/R2 提前 1 季、R3/R4 提前 2 季；下单量 = 未来两季计划投料 − 在手库存 − 在途。
3. **开工/转产/上线**（`startProduction` / `convertProductionLine` / `addProductionLine`）：只在本季有单要交时开工。
4. **交货**（`deliverOrder`）：到期未交的选单，库存够即交。
5. **自救**（`discountReceivable`）：现金低于垫下限且应收池够 7 的倍数时贴现，按 7:1。

**现金垫是动态量，不是常数**。本季现金下界：

```
floor(y,q) = 该季引擎自动支出合计 + 当季到期长贷本息（仅第3年末）+ 当季到期短贷本息 + intent.cashPad
```

引擎自动支出从 `nextQuarter` 的 `totalCashOut` 口径同项推出（料款、安装分期、维护、租金、长贷本息、行政、研发、加工费）。之所以必须动态：**第 3 年末初始长贷 40M 一次性到期**（`drawnAbs = absQuarter(1,1)-4`、`termQuarters: 12`，每年末减 4，第三个年末归零，`settleLongLoansAtYearEnd` 见 `src/utils/rules.ts:46-62`），而当年 `applyLongTermLoan` 会被"未还本余额已达上限40M"拒掉（余额在跨入第 4 年才归零），§4.4 的现金垫因此必须把这一笔单独安排。本局靠第 2 年扩产能抬收入、第 3 年少资本开支、必要时贴现与短贷救急；若实测仍凑不齐，§9-5 的后备方案生效。

**硬不变式**：`decide` 产出的任何步骤序列，都不允许把现金压到 `floor` 之下；违反即视为决策层缺陷，不是剧本可容许的运气问题。

### 4.6 runner 状态机与撞门检测

`idle → playing ⇄ paused → blocked → finished`，外加 `exit`。

step 形状 `{ stepId, label, run, rule?, isPausePoint }`。逐季惰性展开：进入第 Y 年第 Q 季才调 `decide`，因为决策要读实时状态，而剧本只声明意图。

**撞门检测用双信号**：
- 结构性主信号——调用前后 `getState().state` **引用是否变化**。每条成功路径都返回新 `state` 对象，被拒路径只返回 `{ validationError }`，`state` 引用不动。
- 消息——非空 `validationError` 只用来取那句人话原因。

两者不一致（引用变了但仍报错）按"成功但有提示"处理并继续。这样不依赖每条门都记得写消息。

撞门即**停**，不静默跳步：面板显示「第 X 年第 Y 季 · <步骤名> 被拒：<原因>」，给三条出路——重试此步 / 跳过此步 / 退出演示。跳过只影响当季（下季由 decide 重算），不连锁。课堂上讲错比卡住更糟。

自动播放最快档 **300ms/步**，最慢 1200ms/步。这个数字不是手感调出来的：它保证相邻两次操作不会落进同一个 `Date.now()` 毫秒，避开 §3 那条核对盲区——老师若把演示局存档包导出去核对，不会印出一条并不存在的"账实不符"。

### 4.7 界面

`src/app/page.tsx` 加两处挂载，八个中心面板零改动：

- **顶部横幅**（`demoMode` 时）：琥珀色「课堂演示中 · 全部改动只在内存，退出即恢复」+ 当前年月季 + `退出演示`。同一时刻顶部原「暂停运营」按钮置灰，`title` 写明"课堂演示期间不可用：它会拒绝所有变更操作，直接打死演示"。
- **右侧抽屉 `DemoPanel`**（约 360px，可折叠）自上而下四块：播放控制（播放/暂停/单步/跳到下一季/重新开始）、进度（`第2年第3季 · 下原料订单 · 本季还剩 4 步`）、讲解卡（规则原文一条 + 「打开规则说明」）、blocked 报错区。
- **快捷键**：空格 = 播放/暂停，`→` = 单步，`Shift+→` = 跳到下一季。绑定里必须挡输入框焦点（`e.target` 为 `INPUT`/`SELECT`/`TEXTAREA` 时不劫持按键）——主界面有原料数量、广告金额等输入框，吞键会把课堂操作搞坏。

### 4.8 隔离三重闸

1. `autoSaveGame` 首行 `demoMode` 短路（§4.2）。
2. `SaveLoadPanel` 的「手动存档」与两个导入落库按钮在 `demoMode` 下禁用并写明理由；导出类只读动作照常可用——老师可以把演示局的运行控制表 CSV 与存档包导出来当板书资料。
3. `exitDemo()` 用 `demoSnapshot` 恢复。

补最坏情况：演示中途刷新浏览器。当前进度本来就不落 localStorage（§3 第一条），刷新丢掉的只是演示局，老师那一局一字节未动。隔离不依赖退出按钮被按到。

### 4.9 数据流（一次"下一季"）

```
老师点「跳到下一季」
  → runner 把当季剩余 step 依次执行（每步：清 validationError → 调 action → 比 state 引用）
  → 执行 nextQuarter()（引擎自动结算 q-1/2/4/5/7/8/10/11/15/16、跨年时 e-1/2/3/4/6）
  → autoSaveGame 被 demoMode 短路，localStorage 未写
  → runner 展开下一季 decide()，得到新一批 step，回到等待
```

## 5. 错误处理

| 情形 | 处理 |
|---|---|
| 某步撞门（时机不对/现金不足/余额达上限） | 转 `blocked`，显示年季 + 步骤名 + `validationError` 原文，停自动播放，三条出路 |
| `nextQuarter` 因当季透支被拒（`:2749`） | 同上——这正是第 3 年末最需要看清的一格，把缺口金额原样交给老师 |
| 讲解点引用的 section/item 不存在 | 面板退化显示步骤名不显示讲解卡；由 §6 第 4 组测试在 CI 拦住，不允许线上退化 |
| 演示中老师点了被禁的落库按钮 | 按钮 `disabled` + `title` 说明，不给可点状态 |
| 演示中浏览器刷新/关闭 | 无需处理：不写盘，重启后是开局状态，老师的进度本就是内存态 |
| 退出演示后读数异常 | `exitDemo` 深拷贝恢复 + 横幅消失；抽屉内保留一句"已退出演示，本机进度已恢复" |

## 6. 测试策略

环境沿用现状：node、无 jsdom（存档规格 §7）。四条都不依赖浏览器。

1. `tests/demoDecide.test.ts`——纯函数断言：选单集合、原料下单量与在途抵扣、开工线选择、贴现触发条件；含不变式"任何产出序列都不把现金压到 `floor` 之下"。
2. `tests/demoRun.test.ts`——不经 UI 全速跑完 16 季。断言：零 `blocked`、走到 `isGameOver`、结局现金/权益/第 4 年净利等于实测锁定值。**这条是"剧本与规则不脱钩"的守卫**：规则一改剧本失效，它先红。验收门槛：本条必须真跑通才允许放行，跑不通说明剧本资金曲线没调完，不能靠放宽断言过关。
3. `tests/demoIsolation.test.ts`——进演示前 localStorage 里先放一帧存档 → 跑完整局 → 断言 `enterpriseSaveFiles` 逐字节不变、退出后 `state` 与进入前深相等。对着 roadmap §3 P0 那次真实覆盖事故下反向守卫。
4. `tests/integrityCopy.test.ts` 增一组——每个讲解点的 `{section, item}` 在 `RULE_SECTIONS` 里存在且不越界；并断言演示横幅与抽屉里写下的界面说法（按钮名、那句"全部改动只在内存"）在源码里真存在，沿用该文件既有做法。

浏览器内的视觉与快捷键仍需人工或 browser-use 冒烟验收，不能拿测试全绿当已验（roadmap §5.17 的教训）。

## 7. 范围外

- 演示局落盘、进存档列表、断点续播。
- 失败分支示范（超投广告导致透支、晚卖厂房收不到现）。
- 分主题专题局与任意起点跳转。
- What-if 推演（roadmap §3 P3 的硬前置：浅拷贝泄漏未修、`nextQuarter` 未纯函数化）。
- `nextQuarter` 重构与 roadmap §5 那批清理项。
- 新依赖、后端、多浏览器同步。

## 8. 验收判据

- 一台干净机器上：点「课堂演示」→ 不碰任何东西 → 局自己走到第 4 年终局报告，全程零 `blocked`。
- 演示前后本机 `enterpriseSaveFiles` 与老师当前进度逐字节/逐字段一致。
- 任一时刻按暂停，界面读数停在被暂停那一步；单步一次前进一个动作并亮对应讲解卡。
- 第 3 年末跨第 4 年初这一季在剧本下能推过去（长贷 44M 本息有着落）。
- `npx vitest run` 全绿，用例数增加且新增用例来自上述 4 组。

## 9. 假设（用户已认可或本轮判定，复核推翻请指出编号）

1. 演示只面向教师投影，不进学生成绩判定链路，不改任何规则实现。
2. `demoMode` 与 `demoSnapshot` 放 store 顶层而非 `EnterpriseState`，因此存档格式无需 bump、指纹与控制表不受影响。
3. 讲解点引用规则弹窗条目级位置（section id + item index），不新写讲解文案。
4. 订单池按年定种可复现（`marketDemand.ts:58`），故同一剧本每次跑出同一条数值轨迹；日志 id/时间戳不参与"可复现"的定义。
5. 剧本资金曲线以第 3 年末长贷到期为主轴。若实测凑不齐，**后备顺序**定为：先加大贴现与短贷 → 仍不足则第 2 年改为一 quarter 多一条线以抬高第 3 年收入 → 最后才回来和用户讨论"是否把初始长贷安排在第 2 年末就到期"（那属于改规则，超出本期）。
6. 自动播放最快 300ms/步是避开同毫秒核对盲区的最小可行值，不是 UI 手感值。
7. 八个中心面板在演示中保持可交互（老师可以顺手点一下真实按钮），runner 不抢占界面；只有会写本机存档列表的按钮被禁。

## 10. 已知取舍与遗留

1. **runner 的成功判据是 `state` 引用比较**，属于结构性间接信号。将来若有人把某条 action 改成"就地 mutate `state` 对象后返回同引用"，runner 会误判为被拒。缓解：§6 第 2 组全速跑通会立刻抓到大面积 `blocked`；根除要靠 action 层给出显式返回值，本期不动 store 的 30 余个 action 签名。
2. **剧本与规则强耦合**：广告投放、市场维持、贷款上限任一处改动都可能让 §6 第 2 组变红。这是设计意图而非缺陷（规则改了演示就该重新对表），但要求后续维护者跟着改 `script.ts`，不能反过来放宽测试。
3. **decide 的启发式不保证最优**：取向已定为"只要流程完整、不断流"，因此不追求权益最大。某些参数下第 3 年末仍可能吃紧，此时按 §9-5 后备顺序处理。
4. **不做演示局进度保存**：退出即丢。老师若要留存演示结果，用导出控制表 CSV / 存档包（只读动作，演示中可用）。
5. **既有缺口，本期只记录不修**：长贷本息与短贷本息在 `nextQuarter` 内无独立现金守卫，全靠 `:2748-2751` 那条"整季透支则拒绝推进"兜住——结果是季度推不过去而不是负现金，这个行为是对的，但提示语只说"请先贴现应收账款或申请贷款"，不区分是贷款到期造成的。演示会正好撞上这句话，届时按 §5 原样显示，不改文案。
