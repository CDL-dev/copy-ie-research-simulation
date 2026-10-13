// 课堂演示剧本：只声明每年的决策意图与讲解点（规格 §4.4）。老师要改口径就改这个文件，
// 不需要动决策层——具体选哪张单、下几个料由 decide.ts 按实时状态算。
//
// 本文件是**纯数据**：只 import ./types 的类型，不 import store、不 import decide。
// 这是它能脱离 runner 单独审查、也能被守卫测试直接比对的前提（tests/integrityCopy.test.ts）。
//
// 已知行为（不是本功能的 bug，别在 runner 里"修"它）：enterOrderMeeting 读的是
// marketing.advertisements 里所有 period===1 的投放之和（store:1736-1738），而广告记录跨年不清零，
// 于是第 2 年起"解锁张数"是历年广告之和。后果是后几年同样的钱能解锁更多单，
// 上限由 MARKET_DEMAND 的 ordersByYear 卡住，所以实际影响是**广告可以逐年递减**。
import type { RuleRef, YearIntent } from './types';

export const YEAR_INTENTS: Record<1 | 2 | 3 | 4, YearIntent> = {
  1: {
    year: 1, adAmount: 2, orderCap: 3, newLines: [], rdP2: true,
    marketInvest: ['regional'], isoInvest: [], shortLoanQuarters: [], longLoan: false, cashPad: 6,
  },
  2: {
    year: 2, adAmount: 2, orderCap: 4,
    // **为什么是一条半自动 P1 线**（Task 7 第一次真跑定的，草案的"第2年 +1 条全自动 P1"落不了地）：
    // ① 全自动线建不出来——`productionLineLimits.automatic = 2`（store:51-56）而开局两条全自动线已在
    //   （line-1/line-2），配额从第 1 年起就是 0 剩；引擎对超配额是 `return state` 静默空操作
    //   （store:925-932，既不扣钱也不写 validationError），runner 按引用比较判成撞门。
    //   同产能（1 件/季）只剩柔性线，24M 原值、现金流 30M（首付 6M + 4 期 × 6M），本局曲线接不住。
    // ② 原草案"全自动线"的价钱也标低了：一条全自动线现金流是 **20M**（首付 16/4=4M + 每次推进扣一整期
    //   4M × 4 期，store:1010-1011/:2402/:2421-2429），账面原值才 16M——不是本文件早前注释说的"多压 16M"。
    //   半自动同理：现金流 **12M**（首付 4M + 2 期 × 4M）、账面原值 8M，产能还打对折（productionPeriod 2
    //   → 1 件/2 季）。
    // ③ 只留一条：草案的第 2 年两条线（含那条 P2 落点线）实测把第 3 年末关口压穿（缺 14M）。
    //   撤哪一项的次序见规格 §4.4 回写与本任务报告——先撤资本开支，不撤短贷。
    //   P2 因此在本局只有资格、没有产能：`productRD.P2.completed === true` 但一条 P2 线也没上，
    //   第 3 年起 P2 订单进池却一张也选不到（`commitableUnits('P2')` 为 0）。
    //   要把 P2 落点真做出来，得先修 decide.ts 的 `productionSteps`——它每季都重复吐 `newLines[0]`
    //   （`alreadyInvested < wanted` 只数条数、不推进到下标），声明两条只会得到两条一模一样的线。
    newLines: [
      { factoryId: 'factory-1', lineType: 'semi-automatic', product: 'P1' },
    ],
    // 国内市场从**第 2 年**开始投：`MARKET_DEVELOP_YEARS.domestic = 2`，Y2+Y3 两年投满才赶得上
    // 第 4 年 Q1 的订单池（草案是 Y3/Y4 投，那要第 5 年才可用，等于零回报）。实测这一改换来
    // 终局现金 +2M、权益 +1M（有无国内投资的对照见 Task 7 报告 M2 vs M7）。
    rdP2: false, marketInvest: ['local', 'regional', 'domestic'], isoInvest: [],
    shortLoanQuarters: [1], longLoan: false, cashPad: 8,
  },
  3: {
    year: 3, adAmount: 2, orderCap: 5, newLines: [], rdP2: false,
    marketInvest: ['local', 'regional', 'domestic'], isoInvest: [],
    // Q1 与 Q3 各一笔短贷（每次 20M）：Q1 那笔是**续贷**——第 2 年 Q1 借的 20M 恰在跨入第 3 年 Q1
    // 时到期 21M，不续就当季付不出；Q3 那笔才是撑过第 3 年末关口的增量（到期日 abs 15 = 第 4 年 Q3，
    // 落在关口之后）。只留 Q1 的写法实测在第 3 年第 4 季被拒"本季度现金收支后将透支（缺口 19M）"，
    // 两笔都删（草案的第 3 年只在 Q1 借、且把 Q1 那笔删掉）同样过不去——见报告 M1/M11/M12。
    shortLoanQuarters: [1, 3], longLoan: false, cashPad: 8,
  },
  4: {
    year: 4, adAmount: 2, orderCap: 5, newLines: [], rdP2: false,
    // ISO9000 按草案保留（第 4 年才起投，`ISO_REQUIRED_YEARS.ISO9000 = 2` → 终局停在 certifying）。
    // 实测代价：现金 −1M、权益 −2M，而 `src` 里没有任何引擎消费方读 ISO 状态（不进订单池生成、
    // 不参与选单/交货门）——它买到的只有进度条与账面费用。要留白就把它改空，见规格 §4.4 回写。
    marketInvest: ['local', 'regional', 'domestic'], isoInvest: ['ISO9000'],
    // 第 4 年不再申请长贷：草案留它当缓冲，实测不需要（不加也零撞门跑满 16 季，终局现金 8M）。
    // 加了则是现金 26M 但 gameOver 时挂 20M 长贷不改 2M 全年息——终局报告无轧差口径，
    // 观感是"借了不用还"。§4.4 的"收官申请长贷"因此作废。
    shortLoanQuarters: [], longLoan: false, cashPad: 6,
  },
};

/** 讲解点：该 stepId **首次**执行时自动暂停并亮出这条规则原文（规格 §4.6：每个讲解点只停一次） */
export const PAUSE_POINTS: { stepId: string; rule: RuleRef }[] = [
  { stepId: 'b-4', rule: { section: 'cost', item: 1 } },        // 所得税年末计提、下年初交纳
  { stepId: 'q-17', rule: { section: 'ad', item: 1 } },         // 每 1M 广告解锁 2 张
  { stepId: 'b-2', rule: { section: 'orders', item: 0 } },      // 订货会按已准入市场与资格生成订单池
  { stepId: 'q-3', rule: { section: 'finance', item: 1 } },     // 短贷 Q1/Q3 放贷、到期一次还本付息
  { stepId: 'q-6', rule: { section: 'production', item: 0 } },  // R1/R2 提前 1 季、R3/R4 提前 2 季，到货付款
  { stepId: 'q-10', rule: { section: 'production', item: 1 } }, // 开工投料 + 加工费 1M/产品
  { stepId: 'q-8', rule: { section: 'factory', item: 6 } },     // 按安装周期平均支付投资、完工下季才可生产、转产需周期与费用
  { stepId: 'q-14', rule: { section: 'orders', item: 1 } },     // 订单含数量/单价/总额/账期
  { stepId: 'q-11', rule: { section: 'finance', item: 2 } },    // 贴现 7 的倍数、每 7M 付 1M 贴息
  { stepId: 'q-15', rule: { section: 'rd-iso', item: 0 } },     // P2 六季分期 1M/季
  { stepId: 'e-1', rule: { section: 'finance', item: 0 } },     // 长贷年末申请、3 年期 10%
  { stepId: 'e-5', rule: { section: 'market', item: 2 } },      // 市场开拓投资按年度支付（年末操作），每市场每年最多 1M，可中断
];

/**
 * 查讲解点。用 find 而不是 filter：每个 stepId 只该停一次（规格 §4.6），表里若混进重复 stepId，
 * 第二条不可达、静默失效。唯一性由 tests/integrityCopy.test.ts 的
 * `expect(new Set(ids).size).toBe(ids.length)` 钉住（Task 7 补的网），加条目时不必再靠人数列一遍；
 * 当前 12 条：b-4/q-17/b-2/q-3/q-6/q-10/q-8/q-14/q-11/q-15/e-1/e-5。
 */
export const pausePointFor = (stepId: string): { stepId: string; rule: RuleRef } | undefined =>
  PAUSE_POINTS.find((p) => p.stepId === stepId);
