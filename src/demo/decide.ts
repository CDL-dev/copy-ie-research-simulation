// 意图 + 实时状态 → 动作序列（纯函数，规格 §4.5）。这里不做任何状态写入，也不 import store：
// 一旦 import store 就没法用 createFreshState() 造状态单测它了。
import type { EnterpriseState, ProductionLine } from '../types/enterprise';
// PRODUCT_BOM：投料与开工（Task 4）用它算每件成品要哪些料各几个；
// 资金侧（Task 5）用 absQuarter/fromAbsQuarter 定位"跨入的下一季"、用 rules 的结算纯函数预算引擎自动扣费。
import {
  absQuarter, annualRent, DISCOUNT_UNIT, fromAbsQuarter, PRODUCT_BOM,
  settleDueShortLoans, settleLongLoansAtYearEnd,
} from '../utils/rules';
import type { MaterialId } from '../utils/rules';
import type { DemoStep, PlayableProduct, YearIntent } from './types';

export const linesOf = (s: EnterpriseState) =>
  s.production.factories.flatMap((f) => f.productionLines);

// 能排产的状态白名单：running（在生产）、idle（空闲）、stopped（缺料停产，料齐自动复工）。
// installing/converting/maintaining 都不产出——全自动线安装期 4 季，本年新建的线本年产出 0 件，
// 把它当产能会让选单多承诺交不出的量，最终撞 deliverOrder 的库存门（spec §4.5）。
// 用白名单而不是黑名单：以后引擎新增状态时默认不计入产能（fail closed），selling 也顺带排除。
const PRODUCIBLE_STATUS: ReadonlySet<ProductionLine['status']> = new Set<ProductionLine['status']>([
  'running', 'idle', 'stopped',
]);

/**
 * 本年还能承诺多少件：现有成品 + 可排产状态各线（含在手在制品）到年底的完工量 − 已选未交。
 * 全自动线 productionPeriod=1 → 每季 1 件；余量按整除算，宁少不多（选多了交不出会撞库存门）。
 * 状态不在 PRODUCIBLE_STATUS 白名单里的线一律记 0：它们本年产出 0 件，按余量记就是凭空产能。
 * 在制品那一项保留：installing 线根本不会有在制品（enterpriseStore.ts:997 直接给 0），不必为它特判。
 */
export const commitableUnits = (s: EnterpriseState, product: PlayableProduct): number => {
  const quartersLeft = 4 - s.operation.currentQuarter + 1;
  const makeable = linesOf(s)
    .filter((l) => l.product === product && PRODUCIBLE_STATUS.has(l.status))
    .reduce((sum, l) => sum + l.inProgressProducts + Math.floor(quartersLeft / l.productionPeriod), 0);
  const stock = s.logistics.finishedProducts.find((p) => p.type === product)?.quantity ?? 0;
  const promised = s.marketing.selectedOrders
    .filter((o) => !o.isDelivered && o.productType === product)
    .reduce((sum, o) => sum + o.quantity, 0);
  return stock + makeable - promised;
};

/** 单价高优先，同价小单优先、账期短优先；累计量受可承诺量与 orderCap 双重约束 */
export const pickOrders = (s: EnterpriseState, intent: YearIntent): string[] => {
  const sorted = [...s.marketing.availableOrders].sort((a, b) =>
    b.unitPrice - a.unitPrice || a.quantity - b.quantity || a.paymentPeriod - b.paymentPeriod);
  const room: Record<PlayableProduct, number> = {
    P1: commitableUnits(s, 'P1'),
    P2: commitableUnits(s, 'P2'),
  };
  const chosen: string[] = [];
  for (const o of sorted) {
    if (chosen.length >= intent.orderCap) break;
    const product = o.productType as PlayableProduct;
    if (product !== 'P1' && product !== 'P2') continue;   // 本期无 P3/P4 运营入口
    if (room[product] >= o.quantity) {
      room[product] -= o.quantity;
      chosen.push(o.id);
    }
  }
  return chosen;
};

// PRODUCT_BOM 的键类型（P1..P4）；本函数不筛产品：状态里挂着什么产品就按什么 BOM 计，
// P3/P4 线只能来自外部存档而非运营入口（addProductionLine 的 product 参数只有 P1/P2，store:328）。
type MaterialProductKey = keyof typeof PRODUCT_BOM;

/**
 * 每季投料需求（按各线当前产品 BOM 汇总）。
 * 这里刻意不套 PRODUCIBLE_STATUS：本函数问的是"这些线挂的是什么产品"，不是"它们本季能不能产出"。
 * installing / converting / maintaining 的线下一季要开工就得提前备料——投料带提前期（materialSteps 的
 * leadTime + 1）正是为此；把 installing 剔掉，第 2 年新线会一整季没料。
 * 只有 selling 排除：待售残线不再产出，为它备料是纯浪费。
 * 与 commitableUnits（本文件上方）的产能口径同为按 productionPeriod 折算，两处若改必须一起改：
 * 一个把周期折算成"本年能出几件"、一个折算成"每季吃几套料"，任一侧单独动就会让备料和排产对不上账。
 * 注意"口径相同"只是折算基准相同——取整方向刻意相反：产能侧 commitableUnits 用 Math.floor（宁少不多，
 * 多承诺了交不出会撞库存门），备料侧这里用 Math.ceil（宁多不少，少料会让线整季停产）。别读成方向也统一。
 */
export const quarterlyMaterialDemand = (s: EnterpriseState): Record<MaterialId, number> => {
  const demand: Record<MaterialId, number> = { R1: 0, R2: 0, R3: 0, R4: 0 };
  for (const line of linesOf(s)) {
    if (!line.product || line.status === 'selling') continue;
    // 除零守卫：productionPeriod 为 0/负数/undefined 时 ceil(qty/period) 得 Infinity 或 NaN，
    // NaN 会让 materialSteps 的 need <= 0 与 shortfall > 0 双双为 false——整季静默不下单。
    // 兜底按 1 季周期折算：宁可按最快节奏多备料（§4.5 现金垫接住），也不能让线静默没料。
    const period = line.productionPeriod > 0 ? line.productionPeriod : 1;
    for (const [type, qty] of Object.entries(PRODUCT_BOM[line.product as MaterialProductKey])) {
      // 每季均摊这条线的 BOM 消耗：productionPeriod 季的周期里只投一套料。
      // 向上取整——宁可多备一季的量（多压 1M/个料款，且 §4.5 的现金垫会接住），
      // 也不能少备（少料会让线整季停产，那是演示流程断掉，比多花钱严重）。
      demand[type as MaterialId] += Math.ceil((qty ?? 0) / period);
    }
  }
  return demand;
};

/**
 * 这条线本年是否"已经投过"（q-8 的分期投资口径）。
 * 与 PRODUCIBLE_STATUS 是两回事，别混用：本函数问"今年为它掏过钱没有"（installing 当然算掏过），
 * PRODUCIBLE_STATUS 问"今年它能不能排产"（installing 不算）。
 * 安装完成的下一季度才可生产（规则弹窗原文），所以本年已投的线不该再投一条，
 * 否则 orderCap 之外还会多养一条线。
 */
const investedThisYear = (l: ProductionLine, currentYear: number): boolean =>
  l.status === 'installing' || l.builtInYear === currentYear;

/** 下原料订单：到货入库时才付款（store:1516），所以这里只看数量缺口，不看现金 */
export const materialSteps = (s: EnterpriseState): DemoStep[] => {
  const demand = quarterlyMaterialDemand(s);
  const out: DemoStep[] = [];
  for (const type of ['R1', 'R2', 'R3', 'R4'] as MaterialId[]) {
    const need = demand[type];
    if (need <= 0) continue;
    const material = s.logistics.rawMaterials.find((m) => m.type === type);
    const leadTime = material?.leadTime ?? 1;
    const onHand = material?.quantity ?? 0;
    // 在途只算同一种原料：R2 的单子填不了 R3 的坑
    const pending = s.logistics.rawMaterialOrders
      .filter((o) => o.materialType === type)
      .reduce((sum, o) => sum + o.quantity, 0);
    const shortfall = need * (leadTime + 1) - onHand - pending;
    if (shortfall > 0) {
      out.push({ stepId: 'q-6', op: { kind: 'placeRawMaterialOrder', materialType: type, quantity: shortfall } });
    }
  }
  return out;
};

/**
 * q-8 上新线（本年最多落一条）+ q-10 开工。
 * 开工侧只看 PRODUCIBLE_STATUS 白名单：installing / converting / maintaining / selling 的线本季开不了工。
 */
export const productionSteps = (s: EnterpriseState, intent: YearIntent): DemoStep[] => {
  const out: DemoStep[] = [];
  for (const plan of intent.newLines) {
    const factory = s.production.factories.find((f) => f.id === plan.factoryId);
    if (!factory || factory.productionLines.length >= factory.capacity) continue;
    const wanted = intent.newLines.filter((p) => p.factoryId === plan.factoryId).length;
    const alreadyInvested = factory.productionLines.filter(
      (l) => investedThisYear(l, s.operation.currentYear),
    ).length;
    if (alreadyInvested < wanted) {
      out.push({
        stepId: 'q-8',
        op: { kind: 'addProductionLine', factoryId: plan.factoryId, lineType: plan.lineType, product: plan.product },
      });
      break;   // 每季最多落一条：分期投资要占现金，一季落两条会撞加工费/首期门
    }
  }

  for (const line of linesOf(s)) {
    if (!line.product || line.inProgressProducts > 0) continue;
    if (!PRODUCIBLE_STATUS.has(line.status)) continue;
    const product = line.product as PlayableProduct;
    if (product !== 'P1' && product !== 'P2') continue;
    // 料齐判定只看"这一条线需要的量"，不看两条线争同一个料——真争抢时第二条线会撞
    // store 的"原材料不足"门，runner 当场停得下来说得清；在决策层提前复算库存分配是多一套会漂的规则。
    const stocked = Object.entries(PRODUCT_BOM[product]).every(
      ([type, qty]) =>
        (s.logistics.rawMaterials.find((m) => m.type === type)?.quantity ?? 0) >= (qty ?? 0),
    );
    if (stocked) out.push({ stepId: 'q-10', op: { kind: 'startProduction', lineId: line.id } });
  }
  return out;
};

/**
 * 交货步：按 selectedOrders 的数组顺序生成，交一张扣一张。
 * 不能每张单各自对着同一份库存快照判断——两张同品订单各自 quantity ≤ 库存、合计却超库存时
 * （orderCap 默认允许 3 张，这是常见形态），两张都会生成交货步；第一张交完库存就被扣掉
 * （enterpriseStore.ts:2064-2068），第二张必然返回「成品库存不足」（enterpriseStore.ts:2054-2056），
 * runner 当场撞门。所以这里自己维护 remaining，够才生成这一步。
 * 排序沿用数组序、不引入新排序键——挑哪张先交是 Task 5 编排层的事。
 */
export const deliverySteps = (s: EnterpriseState): DemoStep[] => {
  const remaining: Record<PlayableProduct, number> = {
    P1: s.logistics.finishedProducts.find((p) => p.type === 'P1')?.quantity ?? 0,
    P2: s.logistics.finishedProducts.find((p) => p.type === 'P2')?.quantity ?? 0,
  };
  const out: DemoStep[] = [];
  for (const o of s.marketing.selectedOrders) {
    if (o.isDelivered) continue;
    const product = o.productType as PlayableProduct;
    if (product !== 'P1' && product !== 'P2') continue;   // 本期无 P3/P4 运营入口
    if (remaining[product] < o.quantity) continue;
    remaining[product] -= o.quantity;
    out.push({ stepId: 'q-14', op: { kind: 'deliverOrder', orderId: o.id } });
  }
  return out;
};

/**
 * 跨入"下一季"那一刻引擎会自动扣掉的钱（规格 §4.5）。刻意只列**引擎会自己扣**的项：
 * 手动动作（加工费、广告、市场投资）各有自己的现金门，撞了由 runner 报出来，不在这里复算——
 * 复算 `nextQuarter` 那 790 行只会造出第二套会漂的规则。缺一项的后果是演示停下来说得出缺口，
 * 多算一项的后果只是演示保守一点。
 */
export const estAutoOutlay = (s: EnterpriseState): number => {
  const nextAbs = absQuarter(s.operation.currentYear, s.operation.currentQuarter) + 1;
  const { year, quarter } = fromAbsQuarter(nextAbs);
  const crossesYearEnd = quarter === 1;   // 跨入第1季 = 刚结算完上一年的年末

  const shortDue = settleDueShortLoans(s.finance.loans, nextAbs).due;
  const long = crossesYearEnd ? settleLongLoansAtYearEnd(s.finance.loans) : { interest: 0, principalRepaid: 0 };
  const rent = crossesYearEnd ? annualRent(s.production.factories) : 0;
  // 维护费免当年建成（store:2611 用 builtInYear < closingYear），closingYear 即刚结束那年
  const maintenance = crossesYearEnd
    ? linesOf(s).filter((l) => l.builtInYear < year - 1).reduce((sum, l) => sum + l.maintenanceCost, 0)
    : 0;
  const admin = quarter === 4 ? 1 : 0;
  const rd = s.production.productRD.P2.status === 'active' ? 1 : 0;
  const payable = crossesYearEnd ? s.finance.accountsPayable : 0;
  const arriving = s.logistics.rawMaterialOrders
    .filter((o) => o.arrivalPeriod === nextAbs)
    .reduce((sum, o) => sum + o.quantity * o.price, 0);

  return shortDue + long.interest + long.principalRepaid + rent + maintenance + admin + rd + payable + arriving;
};

/** 季末现金垫：预算 + 剧本基线垫；贴现取"够到它的最小 7 的倍数"，救不回就不动（规格 §9-5 后备顺序第 1 档） */
export const rescueSteps = (s: EnterpriseState, intent: YearIntent): DemoStep[] => {
  const floor = estAutoOutlay(s) + intent.cashPad;
  if (s.finance.cash >= floor) return [];
  const totalAR = s.finance.accountsReceivable.reduce((sum, v) => sum + v, 0);
  const max = Math.floor(totalAR / DISCOUNT_UNIT) * DISCOUNT_UNIT;
  for (let amount = DISCOUNT_UNIT; amount <= max; amount += DISCOUNT_UNIT) {
    const gain = amount - amount / DISCOUNT_UNIT;   // 与 rules.discountSplit 同一算法，7M 付 1M 贴息
    if (s.finance.cash + gain >= floor) {
      return [{ stepId: 'q-11', op: { kind: 'discountReceivable', amount } }];
    }
  }
  return [];
};

const yearStartSteps = (s: EnterpriseState, intent: YearIntent): DemoStep[] => {
  const out: DemoStep[] = [];
  if (s.finance.taxesPayable > 0) out.push({ stepId: 'b-4', op: { kind: 'payTaxes' } });
  out.push({ stepId: 'q-17', op: { kind: 'placeAdvertisement', amount: intent.adAmount } });
  out.push({ stepId: 'b-2', op: { kind: 'enterOrderMeeting' } });
  // 选单必须在订货会之后：池是 enterOrderMeeting 现场生成的，id 形如 order-<ms>-<i>，不能预先知道
  for (const orderId of pickOrders(s, intent)) out.push({ stepId: 'b-2', op: { kind: 'selectOrder', orderId } });
  return out;
};

const yearEndSteps = (s: EnterpriseState, intent: YearIntent): DemoStep[] => {
  const out: DemoStep[] = [];
  if (intent.sellFactory) out.push({ stepId: 'q-12', op: { kind: 'sellFactory', factoryId: intent.sellFactory } });
  if (intent.longLoan) out.push({ stepId: 'e-1', op: { kind: 'applyLongTermLoan' } });
  for (const marketType of intent.marketInvest) out.push({ stepId: 'e-5', op: { kind: 'investMarketDevelopment', marketType } });
  for (const isoType of intent.isoInvest) out.push({ stepId: 'e-5', op: { kind: 'investISOCertification', isoType } });
  return out;
};

/** 一季的全部动作；runner 每进一季调一次（逐季惰性展开，规格 §4.6） */
export const decideQuarter = (s: EnterpriseState, intent: YearIntent): DemoStep[] => {
  const quarter = s.operation.currentQuarter;
  const steps: DemoStep[] = [];

  if (quarter === 1) steps.push(...yearStartSteps(s, intent));
  if (intent.shortLoanQuarters.includes(quarter)) steps.push({ stepId: 'q-3', op: { kind: 'applyShortTermLoan' } });
  steps.push(...materialSteps(s));
  steps.push(...productionSteps(s, intent));
  steps.push(...deliverySteps(s));
  if (intent.rdP2 && s.production.productRD.P2.status === 'idle') {
    steps.push({ stepId: 'q-15', op: { kind: 'investProductR_D' } });
  }
  if (quarter === 4) steps.push(...yearEndSteps(s, intent));
  steps.push(...rescueSteps(s, intent));
  steps.push({ stepId: 'q-20', op: { kind: 'nextQuarter' } });

  return steps;
};
