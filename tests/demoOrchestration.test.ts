// 编排层用例：只测 decideQuarter 产出的步序与门槛（规格 §4.5），与纯函数预算组（demoDecide）分开承载，
// 红的时候一眼知道红在哪层。decide 仍是纯函数——这里只 import 状态工厂，不碰 store 的 action。
import { describe, expect, it } from 'vitest';
import { createFreshState } from '../src/store/enterpriseStore';
import { decideQuarter } from '../src/demo/decide';
import type { YearIntent } from '../src/demo/types';

// demoDecide.test.ts 同款 intent() 夹具。两份都是四行数据，控制者已裁定：宁可重复这四行，
// 也不抽成第三个共享文件（多一层间接反而看不清字段默认值出自哪份契约）。
const intent = (over: Partial<YearIntent> = {}): YearIntent => ({
  year: 1, adAmount: 2, orderCap: 3, newLines: [], rdP2: false,
  marketInvest: [], isoInvest: [], shortLoanQuarters: [], longLoan: false, cashPad: 6, ...over,
});

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
