// 意图 + 实时状态 → 动作序列（纯函数，规格 §4.5）。这里不做任何状态写入，也不 import store：
// 一旦 import store 就没法用 createFreshState() 造状态单测它了。
import type { EnterpriseState, ProductionLine } from '../types/enterprise';
// PRODUCT_BOM 本文件暂未消费：materialSteps / productionSteps（Task 4）立刻用它算每件成品要哪些料各几个。
import { PRODUCT_BOM } from '../utils/rules';
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
