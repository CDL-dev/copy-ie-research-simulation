// 编排层用例：只测 decideQuarter 产出的步序与门槛（规格 §4.5），与纯函数预算组（demoDecide）分开承载，
// 红的时候一眼知道红在哪层。decide 仍是纯函数——这里只 import 状态工厂，不碰 store 的 action。
import { describe, expect, it } from 'vitest';
import { createFreshState } from '../src/store/enterpriseStore';
import { decideQuarter } from '../src/demo/decide';
import type { Order } from '../src/types/enterprise';
import type { YearIntent } from '../src/demo/types';

// demoDecide.test.ts 同款 intent() 夹具。两份都是四行数据，控制者已裁定：宁可重复这四行，
// 也不抽成第三个共享文件（多一层间接反而看不清字段默认值出自哪份契约）。
const intent = (over: Partial<YearIntent> = {}): YearIntent => ({
  year: 1, adAmount: 2, orderCap: 3, newLines: [], rdP2: false,
  marketInvest: [], isoInvest: [], shortLoanQuarters: [], longLoan: false, cashPad: 6, ...over,
});

// demoDecide.test.ts 同款 order() 夹具（同一裁定：宁可重复几行数据，不抽共享文件）。
// totalAmount 由 quantity × unitPrice 推导，避免写出引擎产不出来的自相矛盾夹具。
const order = (over: Partial<Order> = {}): Order => {
  const base: Order = {
    id: 'o1', productType: 'P1', quantity: 2, unitPrice: 5, totalAmount: 10,
    paymentPeriod: 2, market: 'local', isSelected: false, isDelivered: false, ...over,
  };
  return { ...base, totalAmount: over.totalAmount ?? base.quantity * base.unitPrice };
};

describe('整季编排', () => {
  it('第1年第1季的步序：税→广告→订货会→选单→原料→开工→交货→研发→贴现(按需)→推进', () => {
    const s = createFreshState();
    const kinds = decideQuarter(s, intent({ rdP2: true })).map((d) => d.op.kind);
    expect(kinds.slice(0, 4)).toEqual(['payTaxes', 'placeAdvertisement', 'enterOrderMeeting', 'placeRawMaterialOrder']);
    expect(kinds[kinds.length - 1]).toBe('nextQuarter');
    expect(kinds).toContain('investProductR_D');
  });

  it('第4季末尾排上年末动作', () => {
    const s = createFreshState();
    s.operation.currentQuarter = 4;
    const kinds = decideQuarter(s, intent({ longLoan: true, marketInvest: ['regional'] })).map((d) => d.op.kind);
    expect(kinds).toEqual(expect.arrayContaining(['applyLongTermLoan', 'investMarketDevelopment', 'nextQuarter']));
    expect(kinds.indexOf('applyLongTermLoan')).toBeLessThan(kinds.indexOf('nextQuarter'));
  });

  it('非第1季不再排年初动作', () => {
    const s = createFreshState();
    s.operation.currentQuarter = 2;
    const kinds = decideQuarter(s, intent()).map((d) => d.op.kind);
    expect(kinds).not.toContain('placeAdvertisement');
    expect(kinds).not.toContain('enterOrderMeeting');
  });

  it('不变式：任何产出序列都不把现金压到保守下界之下（能贴现就先贴现）', () => {
    const s = createFreshState();
    s.finance.cash = 3;
    s.finance.accountsReceivable = [0, 0, 0, 28];
    const kinds = decideQuarter(s, intent({ cashPad: 12 })).map((d) => d.op.kind);
    expect(kinds).toContain('discountReceivable');
  });

  // 修 3 的灵魂用例：rescueSteps 此前只看季初状态，看不见 decide 自己刚排出去的税/广告/加工费。
  // 季初 cash 7 ≥ 旧下界 6（estAutoOutlay 0 + cashPad 6）→ 旧实现不贴现；
  // 但本季要交税 1 + 广告 2 + 两条线开工加工费 1×2 = 5，走完就剩 2，压穿下界。
  // 规格 §4.5 的硬不变式管的是"decide 自己产出的序列不许把现金压到 floor 之下"，这就是决策层缺陷。
  it('季初 cash 够旧下界、但本季自有支出压穿时必须贴现', () => {
    const s = createFreshState();
    s.finance.cash = 7;
    s.finance.accountsReceivable = [0, 0, 0, 14];
    s.production.factories[0].productionLines[0].inProgressProducts = 0;   // 腾空闲 → 两条 startProduction
    s.production.factories[1].productionLines[0].inProgressProducts = 0;   // （开局 R1 3 个，料齐）
    const kinds = decideQuarter(s, intent({ cashPad: 6 })).map((d) => d.op.kind);
    expect(kinds).toContain('discountReceivable');
  });

  // 修 7：引擎只放行第 1、3 季放贷（store:650-652），intent 越界时排了也必撞门，决策层自己拦。
  it('短贷步只在第1、3季发出，intent 越界也不排', () => {
    for (const quarter of [1, 3]) {
      const s = createFreshState();
      s.operation.currentQuarter = quarter;
      const kinds = decideQuarter(s, intent({ shortLoanQuarters: [1, 2, 3, 4] })).map((d) => d.op.kind);
      expect(kinds).toContain('applyShortTermLoan');
    }
    for (const quarter of [2, 4]) {
      const s = createFreshState();
      s.operation.currentQuarter = quarter;
      const kinds = decideQuarter(s, intent({ shortLoanQuarters: [1, 2, 3, 4] })).map((d) => d.op.kind);
      expect(kinds).not.toContain('applyShortTermLoan');
    }
  });

  // 修 8：选单必须排在订货会之后（池是 enterOrderMeeting 现场生成的）——此前只在注释里，没有用例钉住。
  it('选单步排在订货会步之后', () => {
    const s = createFreshState();   // 开局即第1年第1季
    s.marketing.availableOrders = [order({ id: 'a', quantity: 1, unitPrice: 6 }), order({ id: 'b', quantity: 1, unitPrice: 5 })];
    const kinds = decideQuarter(s, intent()).map((d) => d.op.kind);
    expect(kinds).toContain('selectOrder');   // 防空断言：开局 P1 可承诺 15 件，两张 1 件单必被选中
    expect(kinds.indexOf('selectOrder')).toBeGreaterThan(kinds.indexOf('enterOrderMeeting'));
  });

  // 遗留 1（Task 7 清）：ownSpend 以前把"下原料单"划给 estAutoOutlay 覆盖，是假的——
  // 那边的 arriving 只扫季初在途单，扫不到本序列接下来才下的这张；R1/R2 提前期 1（store:145-146、
  // :1540 arrivalAbs = nowAbs + leadTime），到货期恰是 nextAbs，也就是"下一次推进就要扣的钱"两不沾。
  // 这条用例是那个修复的回归闸：floor 少了这 4M 就不会贴现，多这 4M 就必须贴现。
  it('本季下的短提前期原料单计入自有支出：现金垫因此被压穿时当场逼出贴现', () => {
    const s = createFreshState();
    s.operation.currentQuarter = 2;               // 非年初、非跨年：estAutoOutlay 的其他项在开局态全是 0
    s.logistics.rawMaterials[0].quantity = 0;      // R1 清空 → materialSteps 必下一张 R1 单
    s.finance.cash = 8;
    s.finance.accountsReceivable = [0, 0, 0, 14];  // 够贴现一次 7M（到账 6M）
    const kinds = decideQuarter(s, intent({ cashPad: 6 })).map((d) => d.op.kind);
    expect(kinds).toContain('placeRawMaterialOrder');      // 防空断言：确有一张本季下的单
    expect(kinds).toContain('discountReceivable');         // floor = 0 + 6 + 4M 料款 > 8 → 必须自救

    // 对照组：料备足了就不下单，同一份现金/应收/现金垫就不该贴现——证明上面那条不是恒绿
    const stocked = createFreshState();
    stocked.operation.currentQuarter = 2;
    stocked.logistics.rawMaterials[0].quantity = 20;
    stocked.finance.cash = 8;
    stocked.finance.accountsReceivable = [0, 0, 0, 14];
    const stockedKinds = decideQuarter(stocked, intent({ cashPad: 6 })).map((d) => d.op.kind);
    expect(stockedKinds).not.toContain('placeRawMaterialOrder');
    expect(stockedKinds).not.toContain('discountReceivable');
  });
});

// 编排不变式（裁定 3）：简报 4 条只覆盖了第2季的两种年初动作与"最后一项是 nextQuarter"的一次采样，
// 这里把两条升成全季/全意图组合的硬断言——Task 6 剧本、Task 7 runner 都按这两条消费 decideQuarter。
describe('编排不变式', () => {
  // payTaxes 也列进来：简报"非第1季"那条只查了广告与订货会，缴税同样是年初动作（store 门在 quarter 1）。
  const yearStartKinds = ['payTaxes', 'placeAdvertisement', 'enterOrderMeeting'];

  it('四季全意图组合：nextQuarter 恰好出现一次且必为末元素', () => {
    for (const quarter of [1, 2, 3, 4]) {
      const s = createFreshState();
      s.operation.currentQuarter = quarter;
      s.finance.taxesPayable = 3;   // 让 payTaxes 一旦漏出年初门就必然可见
      const kinds = decideQuarter(s, intent({
        rdP2: true, longLoan: true, marketInvest: ['regional'], isoInvest: ['ISO9000'],
        shortLoanQuarters: [1, 3], sellFactory: 'factory-2',
      })).map((d) => d.op.kind);
      const qCount = kinds.filter((k) => k === 'nextQuarter').length;
      expect(qCount).toBe(1);
      expect(kinds[kinds.length - 1]).toBe('nextQuarter');
    }
  });

  it('年初动作（含 payTaxes）只在 quarter===1 出现', () => {
    for (const quarter of [2, 3, 4]) {
      const s = createFreshState();
      s.operation.currentQuarter = quarter;
      s.finance.taxesPayable = 3;
      const kinds = decideQuarter(s, intent()).map((d) => d.op.kind);
      for (const kind of yearStartKinds) expect(kinds).not.toContain(kind);
    }
    // 对照组：第1季 taxesPayable>0 时 payTaxes 必须排在最前——证明上面三季的 not.toContain 不是空断言。
    const t = createFreshState();
    t.finance.taxesPayable = 3;
    const kindsQ1 = decideQuarter(t, intent()).map((d) => d.op.kind);
    expect(kindsQ1.slice(0, 3)).toEqual(['payTaxes', 'placeAdvertisement', 'enterOrderMeeting']);
  });
});
