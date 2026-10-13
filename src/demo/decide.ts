// 意图 + 实时状态 → 动作序列（纯函数，规格 §4.5）。这里不做任何状态写入，也不 import store：
// 一旦 import store 就没法用 createFreshState() 造状态单测它了。
import type { EnterpriseState, ProductionLine } from '../types/enterprise';
// PRODUCT_BOM：投料与开工（Task 4）用它算每件成品要哪些料各几个。
import { PRODUCT_BOM } from '../utils/rules';
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

// PRODUCT_BOM 的键类型（P1..P4）；本函数只按已开放的产品取料
type MaterialProductKey = keyof typeof PRODUCT_BOM;

/**
 * 每季投料需求（按各线当前产品 BOM 汇总）。
 * 这里刻意不套 PRODUCIBLE_STATUS：本函数问的是"这些线挂的是什么产品"，不是"它们本季能不能产出"。
 * installing / converting / maintaining 的线下一季要开工就得提前备料——投料带提前期（materialSteps 的
 * leadTime + 1）正是为此；把 installing 剔掉，第 2 年新线会一整季没料。
 * 只有 selling 排除：待售残线不再产出，为它备料是纯浪费。
 */
export const quarterlyMaterialDemand = (s: EnterpriseState): Record<MaterialId, number> => {
  const demand: Record<MaterialId, number> = { R1: 0, R2: 0, R3: 0, R4: 0 };
  for (const line of linesOf(s)) {
    if (!line.product || line.status === 'selling') continue;
    for (const [type, qty] of Object.entries(PRODUCT_BOM[line.product as MaterialProductKey])) {
      demand[type as MaterialId] += qty ?? 0;
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
