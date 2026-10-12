// 意图 + 实时状态 → 动作序列（纯函数，规格 §4.5）。这里不做任何状态写入，也不 import store：
// 一旦 import store 就没法用 createFreshState() 造状态单测它了。
import type { EnterpriseState } from '../types/enterprise';
import { PRODUCT_BOM, type MaterialId } from '../utils/rules';
import type { DemoStep, PlayableProduct, YearIntent } from './types';

export const linesOf = (s: EnterpriseState) =>
  s.production.factories.flatMap((f) => f.productionLines);

/**
 * 本年还能承诺多少件：现有成品 + 各线（含在手在制品）到年底的完工量 − 已选未交。
 * 全自动线 productionPeriod=1 → 每季 1 件；余量按整除算，宁少不多（选多了交不出会撞库存门）。
 */
export const commitableUnits = (s: EnterpriseState, product: PlayableProduct): number => {
  const quartersLeft = 4 - s.operation.currentQuarter + 1;
  const makeable = linesOf(s)
    .filter((l) => l.product === product && l.status !== 'selling')
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

export const deliverySteps = (s: EnterpriseState): DemoStep[] =>
  s.marketing.selectedOrders
    .filter((o) => !o.isDelivered)
    .filter((o) => (s.logistics.finishedProducts.find((p) => p.type === o.productType)?.quantity ?? 0) >= o.quantity)
    .map((o) => ({ stepId: 'q-14', op: { kind: 'deliverOrder', orderId: o.id } as DemoStep['op'] }));
