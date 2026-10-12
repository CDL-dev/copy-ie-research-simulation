// 决策层是纯函数（规格 §4.1：decide 不 import store），所以直接喂状态、读动作描述符。
// 本仓库测试环境是 node、无 jsdom（存档规格 §7），store 级与纯函数级两套都测不了渲染，这里只测数据。
import { describe, expect, it } from 'vitest';
import { createFreshState } from '../src/store/enterpriseStore';
import type { Order } from '../src/types/enterprise';
import { commitableUnits, deliverySteps, pickOrders } from '../src/demo/decide';
import type { YearIntent } from '../src/demo/types';

const intent = (over: Partial<YearIntent> = {}): YearIntent => ({
  year: 1, adAmount: 2, orderCap: 3, newLines: [], rdP2: false,
  marketInvest: [], isoInvest: [], shortLoanQuarters: [], longLoan: false, cashPad: 6, ...over,
});

const order = (over: Partial<Order>): Order => ({
  id: 'o1', productType: 'P1', quantity: 2, unitPrice: 5, totalAmount: 10,
  paymentPeriod: 2, market: 'local', isSelected: false, isDelivered: false, ...over,
});

describe('选单', () => {
  it('按单价降序取，够不着产能的单跳过而不是硬塞', () => {
    const s = createFreshState();
    s.marketing.availableOrders = [
      order({ id: 'big-unfit', quantity: 16, unitPrice: 6 }),   // 单价最高，但超出本年可承诺量
      order({ id: 'fit-a', quantity: 2, unitPrice: 5 }),
      order({ id: 'fit-b', quantity: 3, unitPrice: 4 }),
    ];
    // 开局可承诺量 = 成品 3 + 两条线（在手各 2 件 + 每季 1 件×4 季）= 15 件，16 件那张必然被跳过
    expect(pickOrders(s, intent({ orderCap: 3 }))).toEqual(['fit-a', 'fit-b']);
  });

  it('orderCap 是硬上限', () => {
    const s = createFreshState();
    s.marketing.availableOrders = [
      order({ id: 'a', quantity: 1 }), order({ id: 'b', quantity: 1 }), order({ id: 'c', quantity: 1 }),
    ];
    s.logistics.finishedProducts = s.logistics.finishedProducts.map((p) => ({ ...p, quantity: 50 }));
    s.production.factories[0].productionLines[0].inProgressProducts = 0;
    expect(pickOrders(s, intent({ orderCap: 2 }))).toHaveLength(2);
  });

  it('已承诺未交的量从可承诺量里扣', () => {
    const s = createFreshState();
    const free = commitableUnits(s, 'P1');
    s.marketing.selectedOrders = [order({ id: 'taken', quantity: 2 })];
    expect(commitableUnits(s, 'P1')).toBe(free - 2);
  });
});

describe('交货', () => {
  it('库存够的未交单才生成 deliverOrder 步', () => {
    const s = createFreshState();   // 开局 P1 成品 3 个
    s.marketing.selectedOrders = [
      order({ id: 'can', quantity: 3 }),
      order({ id: 'cant', quantity: 4 }),
      order({ id: 'done', quantity: 1, isDelivered: true }),
    ];
    expect(deliverySteps(s).map((d) => d.op)).toEqual([{ kind: 'deliverOrder', orderId: 'can' }]);
    expect(deliverySteps(s)[0].stepId).toBe('q-14');
  });
});
