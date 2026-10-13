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
    // 两条都上在全自动线上：P1 抬当年的量，P2 是第1年那 6M 研发的落点。
    // 没有这条 P2 线，rdP2 买到的资格产能为 0，pickOrders 的 P2 池常年只剩成品库存 0——那 6M 是死钱。
    // 代价是第2年多压 16M 分期投资：Task 7 的调参循环若把第3年末的现金关口压穿，先撤这条 P2 线，
    // 不要撤短贷或去改第3年的还本安排（撤它只是少一个产品，撤关口是流程断掉）。
    // 实际现金流比账面原值贵：全自动线建线当场付首付 16/4=4M（store:1010-1011），此后每次推进
    // 对 installing 的线再扣一整期 4M（store:2402），进度到 4 才完工（store:2421-2429）——
    // 4 期共 16M 加首付，**一条线 20M 现金流、账面只有 16M**，两条就是 40M。
    newLines: [
      { factoryId: 'factory-1', lineType: 'automatic', product: 'P1' },
      { factoryId: 'factory-1', lineType: 'automatic', product: 'P2' },
    ],
    rdP2: false, marketInvest: ['local', 'regional'], isoInvest: [],
    shortLoanQuarters: [1], longLoan: false, cashPad: 8,
  },
  3: {
    year: 3, adAmount: 2, orderCap: 5, newLines: [], rdP2: false,
    marketInvest: ['local', 'regional', 'domestic'], isoInvest: [],
    shortLoanQuarters: [1], longLoan: false, cashPad: 8,
  },
  4: {
    year: 4, adAmount: 2, orderCap: 5, newLines: [], rdP2: false,
    marketInvest: ['local', 'regional', 'domestic'], isoInvest: ['ISO9000'],
    shortLoanQuarters: [], longLoan: true, cashPad: 6,
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
 * 第二条不可达、静默失效。**注意这条不变式当前没有测试守着**——守卫用例只验 stepId 是否
 * 存在于 CONTROL_STEPS（tests/integrityCopy.test.ts），不验唯一性，所以加条目时自己数一遍：
 * 当前 12 条的 stepId 两两不同（b-4/q-17/b-2/q-3/q-6/q-10/q-8/q-14/q-11/q-15/e-1/e-5）。
 */
export const pausePointFor = (stepId: string): { stepId: string; rule: RuleRef } | undefined =>
  PAUSE_POINTS.find((p) => p.stepId === stepId);
